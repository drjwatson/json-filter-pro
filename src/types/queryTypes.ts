import * as vscode from "vscode";

export type RuleOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not in"
  | "exists"
  | "regex"
  | "match"
  | "matchAll";

export interface RulesEngineRule {
  id: string;
  path: string;
  operator: RuleOperator;
  value: string;
  flags?: string;
}

export interface ExecuteQueryRequest {
  query: string;
}

export interface QueryExecutionConfig {
  largeFileThresholdMb: number;
  previewResultLimit: number;
}

export interface QueryExecutionResult {
  mode: "full-document" | "stream-filter";
  filePath: string;
  fileSizeBytes: number;
  elapsedMs: number;
  scannedItems: number;
  matchedItems: number;
  truncated: boolean;
  result: unknown;
  warning?: string;
}

export type WebviewInboundMessage =
  | { type: "ready" }
  | { type: "pickFile" }
  | { type: "executeQuery"; payload: ExecuteQueryRequest }
  | {
      type: "copyToClipboard";
      payload: {
        text: string;
      };
    };

export type WebviewOutboundMessage =
  | {
      type: "setActiveFile";
      payload: {
        uri: string;
        fsPath: string;
        fileName: string;
        fileSizeBytes: number;
        keyPaths: string[];
      };
    }
  | {
      type: "clearActiveFile";
      payload: {
        reason: string;
      };
    }
  | {
      type: "executionStarted";
      payload: {
        query: string;
      };
    }
  | {
      type: "executionCompleted";
      payload: QueryExecutionResult;
    }
  | {
      type: "executionFailed";
      payload: {
        message: string;
      };
    };

export interface FileSelection {
  uri: vscode.Uri;
  fileSizeBytes: number;
  keyPaths: string[];
}
