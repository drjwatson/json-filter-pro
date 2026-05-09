import * as vscode from "vscode";
import { JsonFilterViewProvider } from "./providers/jsonFilterViewProvider";

async function resolveTargetUri(providedUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (providedUri?.scheme === "file" && providedUri.fsPath.toLowerCase().endsWith(".json")) {
    return providedUri;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === "file" && activeUri.fsPath.toLowerCase().endsWith(".json")) {
    return activeUri;
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new JsonFilterViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(JsonFilterViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jsonFilterPro.openPanelForFile", async (uri?: vscode.Uri) => {
      try {
        const targetUri = await resolveTargetUri(uri);
        if (!targetUri) {
          void vscode.window.showWarningMessage(
            "JSON Filter Pro: Select a .json file in Explorer, then run Open JSON Filter Pro."
          );
          return;
        }

        await provider.setActiveFile(targetUri);
        await vscode.commands.executeCommand("workbench.view.extension.jsonFilterPro");
        provider.reveal();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`JSON Filter Pro failed to open: ${message}`);
      }
    })
  );
}

export function deactivate(): void {}
