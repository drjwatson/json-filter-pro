import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { basename } from "path";
import { QueryExecutionConfig, QueryExecutionResult } from "../types/queryTypes";
import {
  compileQueryAst,
  executeFullDocumentQuery,
  formatQueryError,
  parseQueryText
} from "./jsonQueryService";
import { analyzeLargeFileCompatibility } from "./queryCapabilityAnalyzer";

interface StreamStats {
  scanned: number;
  matched: number;
  truncated: boolean;
  result: unknown[];
}

interface StreamOptions {
  maxCollectedMatches: number;
  stopAfterMatchedCount?: number;
  evaluateObject: (item: unknown) => boolean;
}

const BYTES_PER_MB = 1024 * 1024;
const LARGE_MODE_MATCH_COLLECTION_LIMIT = 200000;

function trimPreview(result: unknown, previewResultLimit: number): { value: unknown; truncated: boolean; matchedItems: number } {
  if (!Array.isArray(result)) {
    return {
      value: result,
      truncated: false,
      matchedItems: 1
    };
  }

  const matchedItems = result.length;
  if (result.length <= previewResultLimit) {
    return {
      value: result,
      truncated: false,
      matchedItems
    };
  }

  return {
    value: result.slice(0, previewResultLimit),
    truncated: true,
    matchedItems
  };
}

function toUnexpectedParseError(filePath: string): Error {
  return new Error(
    `Large-file stream mode currently expects a root JSON array of objects in ${basename(filePath)}.`
  );
}

async function streamRootArrayObjects(filePath: string, options: StreamOptions): Promise<StreamStats> {
  const stream = fs.createReadStream(filePath, {
    encoding: "utf8"
  });

  let sawArrayStart = false;
  let sawArrayEnd = false;
  let capturingObject = false;
  let objectDepth = 0;
  let buffer = "";
  let inString = false;
  let escaped = false;
  let stopRequested = false;

  const result: unknown[] = [];
  let scanned = 0;
  let matched = 0;
  let truncated = false;

  const flushObject = () => {
    const objectText = buffer.trim();
    buffer = "";

    if (!objectText) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(objectText);
    } catch {
      throw toUnexpectedParseError(filePath);
    }

    scanned += 1;
    const keep = options.evaluateObject(parsed);
    if (keep) {
      matched += 1;
      if (result.length < options.maxCollectedMatches) {
        result.push(parsed);
      } else {
        truncated = true;
        stopRequested = true;
        return;
      }

      if (
        options.stopAfterMatchedCount !== undefined &&
        matched >= options.stopAfterMatchedCount
      ) {
        stopRequested = true;
      }
    }
  };

  try {
    for await (const chunk of stream) {
      if (stopRequested) {
        break;
      }

      const textChunk = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of textChunk) {
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
              if (stopRequested) {
                break;
              }
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
          throw toUnexpectedParseError(filePath);
        }

        if (/\s/.test(char) || char === ",") {
          continue;
        }

        if (char === "]") {
          sawArrayEnd = true;
          stopRequested = true;
          break;
        }

        if (char !== "{") {
          throw toUnexpectedParseError(filePath);
        }

        capturingObject = true;
        objectDepth = 1;
        inString = false;
        escaped = false;
        buffer = "{";
      }
    }
  } finally {
    stream.destroy();
  }

  if (!sawArrayStart || (!sawArrayEnd && !stopRequested)) {
    throw toUnexpectedParseError(filePath);
  }

  return {
    scanned,
    matched,
    truncated,
    result
  };
}

export async function executeQueryAgainstFile(
  filePath: string,
  queryText: string,
  config: QueryExecutionConfig
): Promise<QueryExecutionResult> {
  const startTime = Date.now();
  const fileStat = await fsPromises.stat(filePath);
  const thresholdBytes = Math.max(1, config.largeFileThresholdMb) * BYTES_PER_MB;

  if (fileStat.size <= thresholdBytes) {
    try {
      const raw = await fsPromises.readFile(filePath, "utf8");
      const data = JSON.parse(raw) as unknown;
      const queryOutput = await executeFullDocumentQuery(data, queryText);
      const preview = trimPreview(queryOutput, config.previewResultLimit);

      return {
        mode: "full-document",
        filePath,
        fileSizeBytes: fileStat.size,
        elapsedMs: Date.now() - startTime,
        scannedItems: Array.isArray(data) ? data.length : 1,
        matchedItems: preview.matchedItems,
        truncated: preview.truncated,
        result: preview.value,
        warning: preview.truncated
          ? `Result truncated to ${config.previewResultLimit} items for responsiveness.`
          : undefined
      };
    } catch (error) {
      throw new Error(formatQueryError(error));
    }
  }

  const largePlan = await analyzeLargeFileCompatibility(queryText);
  if (!largePlan.isLargeFileSafe || !largePlan.filterAst) {
    throw new Error(
      largePlan.reason ||
        "The query is not compatible with large-file mode. Use a filter-first pipeline (for example: filter(...) | {...})."
    );
  }

  const parsed = await parseQueryText(queryText);
  const compiledFilter = await compileQueryAst(largePlan.filterAst);
  const hasPostFilterTransform = largePlan.postFilterAst !== undefined;

  const stopAfterMatchedCount = largePlan.queryLimit;
  const maxCollectedMatches = hasPostFilterTransform
    ? Math.max(1, stopAfterMatchedCount ?? LARGE_MODE_MATCH_COLLECTION_LIMIT)
    : Math.max(1, Math.min(config.previewResultLimit, stopAfterMatchedCount ?? Number.POSITIVE_INFINITY));

  const streamStats = await streamRootArrayObjects(filePath, {
    maxCollectedMatches,
    stopAfterMatchedCount,
    evaluateObject: (item) => {
      try {
        const output = compiledFilter([item]);
        return Array.isArray(output) && output.length > 0;
      } catch {
        return false;
      }
    }
  });

  if (hasPostFilterTransform) {
    let transformedResult: unknown;
    try {
      const compiledPostFilter = await compileQueryAst(largePlan.postFilterAst);
      transformedResult = compiledPostFilter(streamStats.result);
    } catch (error) {
      throw new Error(formatQueryError(error));
    }

    const preview = trimPreview(transformedResult, config.previewResultLimit);
    const warningParts = [
      `Executed in large-file mode for ${basename(filePath)}.`,
      `Query normalized as ${parsed.normalizedText}.`
    ];

    if (streamStats.truncated) {
      warningParts.push(
        `Matched rows exceeded ${maxCollectedMatches}; post-filter transform used a partial result.`
      );
    }
    if (preview.truncated) {
      warningParts.push(`Output preview truncated to ${config.previewResultLimit} items.`);
    }

    return {
      mode: "stream-filter",
      filePath,
      fileSizeBytes: fileStat.size,
      elapsedMs: Date.now() - startTime,
      scannedItems: streamStats.scanned,
      matchedItems: streamStats.matched,
      truncated: streamStats.truncated || preview.truncated,
      result: preview.value,
      warning: warningParts.join(" ")
    };
  }

  return {
    mode: "stream-filter",
    filePath,
    fileSizeBytes: fileStat.size,
    elapsedMs: Date.now() - startTime,
    scannedItems: streamStats.scanned,
    matchedItems: streamStats.matched,
    truncated: streamStats.truncated,
    result: streamStats.result,
    warning: `Executed in large-file mode for ${basename(filePath)}. Query normalized as ${parsed.normalizedText}.`
  };
}
