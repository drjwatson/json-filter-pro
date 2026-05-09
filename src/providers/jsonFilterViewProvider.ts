import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { executeQueryAgainstFile } from "../services/largeJsonExecutionService";
import {
  FileSelection,
  QueryExecutionConfig,
  WebviewInboundMessage,
  WebviewOutboundMessage
} from "../types/queryTypes";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_KEY_PATHS = 500;
const MAX_KEY_DEPTH = 6;
const SMALL_FILE_LIMIT_BYTES = 6 * 1024 * 1024;
const LARGE_FILE_SAMPLE_OBJECTS = 400;
const LARGE_OBJECT_KEY_PARSE_LIMIT_BYTES = 64 * 1024 * 1024;

async function readFirstSignificantChar(filePath: string): Promise<string | undefined> {
  const handle = await fsPromises.open(filePath, "r");
  const buffer = Buffer.alloc(4096);
  let position = 0;

  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        return undefined;
      }

      const chunk = buffer.toString("utf8", 0, bytesRead);
      for (const char of chunk) {
        if (!/\s/.test(char)) {
          return char;
        }
      }

      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

function collectKeyPathsFromValue(
  value: unknown,
  keyPaths: Set<string>,
  prefix = "",
  depth = 0
): void {
  if (depth > MAX_KEY_DEPTH || keyPaths.size >= MAX_KEY_PATHS) {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > 0) {
      collectKeyPathsFromValue(value[0], keyPaths, prefix, depth + 1);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const pathLabel = prefix ? `${prefix}.${key}` : key;
    keyPaths.add(pathLabel);
    if (keyPaths.size >= MAX_KEY_PATHS) {
      return;
    }
    collectKeyPathsFromValue(child, keyPaths, pathLabel, depth + 1);
  }
}

async function sampleRootArrayObjects(filePath: string, maxObjects: number): Promise<unknown[]> {
  const stream = fs.createReadStream(filePath, {
    encoding: "utf8"
  });

  let sawArrayStart = false;
  let capturingObject = false;
  let objectDepth = 0;
  let buffer = "";
  let inString = false;
  let escaped = false;
  let done = false;

  const sample: unknown[] = [];

  const flushObject = () => {
    const objectText = buffer.trim();
    buffer = "";
    if (!objectText) {
      return;
    }

    const parsed = JSON.parse(objectText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      sample.push(parsed);
    }
    if (sample.length >= maxObjects) {
      done = true;
    }
  };

  try {
    for await (const chunk of stream) {
      if (done) {
        break;
      }

      const textChunk = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of textChunk) {
        if (done) {
          break;
        }

        if (capturingObject) {
          buffer += char;

          if (inString) {
            if (escaped) {
              escaped = false;
            } else if (char === "\\") {
              escaped = true;
            } else if (char === '"') {
              inString = false;
            }
            continue;
          }

          if (char === '"') {
            inString = true;
            continue;
          }

          if (char === "{") {
            objectDepth += 1;
            continue;
          }

          if (char === "}") {
            objectDepth -= 1;
            if (objectDepth === 0) {
              capturingObject = false;
              flushObject();
            }
            continue;
          }

          continue;
        }

        if (!sawArrayStart) {
          if (/\s/.test(char)) {
            continue;
          }
          if (char === "[") {
            sawArrayStart = true;
            continue;
          }
          return [];
        }

        if (/\s/.test(char) || char === ",") {
          continue;
        }

        if (char === "]") {
          done = true;
          break;
        }

        if (char !== "{") {
          return [];
        }

        capturingObject = true;
        objectDepth = 1;
        inString = false;
        escaped = false;
        buffer = "{";
      }
    }
  } catch {
    return [];
  } finally {
    stream.destroy();
  }

  return sample;
}

async function collectFileKeyPaths(filePath: string): Promise<string[]> {
  try {
    const stat = await fsPromises.stat(filePath);
    const keyPaths = new Set<string>();

    if (stat.size <= SMALL_FILE_LIMIT_BYTES) {
      const raw = await fsPromises.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const value of parsed.slice(0, LARGE_FILE_SAMPLE_OBJECTS)) {
          collectKeyPathsFromValue(value, keyPaths);
          if (keyPaths.size >= MAX_KEY_PATHS) {
            break;
          }
        }
      } else {
        collectKeyPathsFromValue(parsed, keyPaths);
      }
    } else {
      const firstChar = await readFirstSignificantChar(filePath);

      if (firstChar === "{") {
        // For object roots, a full parse with a size cap lets us detect nested keys like entries.id.
        if (stat.size <= LARGE_OBJECT_KEY_PARSE_LIMIT_BYTES) {
          const raw = await fsPromises.readFile(filePath, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          collectKeyPathsFromValue(parsed, keyPaths);
        }
      } else {
        const sample = await sampleRootArrayObjects(filePath, LARGE_FILE_SAMPLE_OBJECTS);
        for (const value of sample) {
          collectKeyPathsFromValue(value, keyPaths);
          if (keyPaths.size >= MAX_KEY_PATHS) {
            break;
          }
        }
      }
    }

    return Array.from(keyPaths).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function getSelection(uri: vscode.Uri): Promise<FileSelection> {
  const stat = await vscode.workspace.fs.stat(uri);
  return {
    uri,
    fileSizeBytes: stat.size,
    keyPaths: await collectFileKeyPaths(uri.fsPath)
  };
}

export class JsonFilterViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "jsonFilterPro.rulesView";

  private view?: vscode.WebviewView;
  private activeFile?: FileSelection;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public reveal(): void {
    this.view?.show?.(true);
  }

  public async setActiveFile(uri: vscode.Uri): Promise<void> {
    this.activeFile = await getSelection(uri);
    await this.postActiveFile();
  }

  public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "src", "webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewInboundMessage) => {
      if (message.type === "ready") {
        await this.postActiveFile();
        return;
      }

      if (message.type === "pickFile") {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Use JSON File",
          filters: {
            JSON: ["json"]
          }
        });

        if (!picked || picked.length === 0) {
          return;
        }

        this.activeFile = await getSelection(picked[0]);
        await this.postActiveFile();
        return;
      }

      if (message.type === "executeQuery") {
        await this.runQuery(message.payload.query);
        return;
      }

      if (message.type === "copyToClipboard") {
        await vscode.env.clipboard.writeText(message.payload.text);
        void vscode.window.setStatusBarMessage("JSON Filter Pro: Copied selected JSON", 1500);
      }
    });
  }

  private getConfig(): QueryExecutionConfig {
    const config = vscode.workspace.getConfiguration("jsonFilterPro");
    return {
      largeFileThresholdMb: config.get<number>("largeFileThresholdMb", 64),
      previewResultLimit: config.get<number>("previewResultLimit", 500)
    };
  }

  private async runQuery(queryText: string): Promise<void> {
    if (!this.view) {
      return;
    }

    const trimmed = queryText.trim();
    if (!trimmed) {
      await this.postMessage({
        type: "executionFailed",
        payload: {
          message: "Query is empty. Build a rule or type a JSON Query statement first."
        }
      });
      return;
    }

    if (!this.activeFile) {
      await this.postMessage({
        type: "executionFailed",
        payload: {
          message: "No active JSON file selected. Use Explorer right-click or Pick JSON File."
        }
      });
      return;
    }

    await this.postMessage({
      type: "executionStarted",
      payload: {
        query: trimmed
      }
    });

    try {
      const result = await executeQueryAgainstFile(
        this.activeFile.uri.fsPath,
        trimmed,
        this.getConfig()
      );

      await this.postMessage({
        type: "executionCompleted",
        payload: result
      });
    } catch (error) {
      await this.postMessage({
        type: "executionFailed",
        payload: {
          message: toMessage(error)
        }
      });
    }
  }

  private async postActiveFile(): Promise<void> {
    if (!this.view) {
      return;
    }

    if (!this.activeFile) {
      await this.postMessage({
        type: "clearActiveFile",
        payload: {
          reason: "No JSON file selected yet."
        }
      });
      return;
    }

    await this.postMessage({
      type: "setActiveFile",
      payload: {
        uri: this.activeFile.uri.toString(),
        fsPath: this.activeFile.uri.fsPath,
        fileName: path.basename(this.activeFile.uri.fsPath),
        fileSizeBytes: this.activeFile.fileSizeBytes,
        keyPaths: this.activeFile.keyPaths
      }
    });
  }

  private async postMessage(message: WebviewOutboundMessage): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "src", "webview", "styles.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "src", "webview", "main.js")
    );
    const nonce = Date.now().toString(36);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>JSON Filter Pro</title>
</head>
<body>
  <main class="app-shell">
    <details class="panel-card panel-detail file-card" open>
      <summary class="panel-summary">
        <h2>File</h2>
      </summary>
      <div class="panel-body compact-file-body">
        <div class="file-row">
          <input id="activeFileField" class="file-select" type="text" value="" placeholder="No JSON file selected" readonly />
          <button id="pickFileBtn" type="button">Browse</button>
        </div>
        <div id="activeFile" class="file-status">No file loaded.</div>
        <div class="row-inline compact">
          <label for="entryPath">Entries Path</label>
          <select id="entryPath"></select>
        </div>
      </div>
    </details>

    <details class="panel-card panel-detail filters-card" open>
      <summary class="panel-summary">
        <h2>Filters</h2>
      </summary>
      <div class="panel-body">
        <div class="card-head">
          <div class="row-inline compact">
            <label for="groupMode">Group Logic</label>
            <select id="groupMode">
              <option value="and">AND</option>
              <option value="or">OR</option>
            </select>
            <label class="inline-check" for="negateGroup">
              <input id="negateGroup" type="checkbox" />
              NOT Group
            </label>
          </div>
        </div>

        <div id="rulesList" class="rules-list"></div>

        <div class="rule-actions">
          <button id="addRuleBtn" type="button" class="icon-with-text" title="Add filter">
            <span class="icon">+</span>
            <span>Filter</span>
          </button>
          <button id="clearRulesBtn" type="button" class="ghost" title="Clear all rules">Clear Rules</button>
        </div>
      </div>
    </details>

    <details class="panel-card panel-detail pipeline-card" open>
      <summary class="panel-summary">
        <h2>Output & Transforms</h2>
      </summary>
      <div class="panel-body">
        <div id="pipelineRows" class="pipeline-rows"></div>
        <div class="step-actions">
          <button id="addPipelineStepBtn" type="button" class="icon-with-text" title="Add pipeline step">
            <span class="icon">+</span>
            <span>Step</span>
          </button>
          <button id="clearStepsBtn" type="button" class="ghost" title="Clear all pipeline steps">Clear Steps</button>
        </div>
      </div>
    </details>

    <details class="panel-card panel-detail query-card">
      <summary class="panel-summary">
        <h2>Generated Query</h2>
      </summary>
      <div class="panel-body">
        <textarea id="queryEditor" rows="6" spellcheck="false"></textarea>
        <div class="row-inline">
          <button id="regenerateBtn" type="button" class="ghost icon-with-text" title="Regenerate query from current rules">
            <span class="icon">&#8635;</span>
            <span>Regenerate</span>
          </button>
          <span id="queryState" class="state-pill">Synced with rules</span>
        </div>
      </div>
    </details>

    <details class="panel-card panel-detail results-card" open>
      <summary class="panel-summary">
        <h2>Results</h2>
        <div id="resultsMeta" class="results-meta">No execution yet.</div>
      </summary>
      <div class="panel-body results-body">
        <div id="resultsTree" class="results-tree"></div>
      </div>
    </details>

    <div class="run-strip">
      <button id="runQueryBtn" type="button" class="primary run-query-btn">Run Query</button>
    </div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
