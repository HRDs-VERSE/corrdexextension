export const GET_SIDEBAR_SNAPSHOT_REQUEST = "corrdex/getSidebarSnapshot";
export const GET_FILE_CONTEXT_REQUEST = "corrdex/getFileContext";
export const SYNC_TO_SERVER_REQUEST = "corrdex/syncToServer";

export interface SyncToServerRequest {
  projectId: string;
  serverBaseUrl: string;
  apiKey: string;
}

export interface SyncToServerResponse {
  ok: boolean;
  message: string;
  filesUploaded?: number;
  jobId?: string;
  indexRun?: { ok: boolean; status?: number; runId?: string };
  scanRun?: { ok: boolean; status?: number; runId?: string };
}

export interface SidebarSnapshotRequest {
  uri: string;
}

export interface SidebarSnapshot {
  filePath: string;
  primaryType: string;
  confidence: number;
  dependencyCounts: {
    internal: number;
    external: number;
  };
  behaviors: Array<{
    type: string;
    confidence: number;
    evidence: string[];
  }>;
  roles: Array<{
    type: string;
    confidence: number;
    evidence: string[];
  }>;
  findings: Array<{
    type: string;
    severity: "info" | "warning" | "error";
    confidence: number;
    description?: string;
    evidence: string[];
  }>;
  diagnostics: Array<{
    ruleId: string;
    severity: "off" | "warning" | "error" | "info";
    message: string;
    line: number;
    column: number;
  }>;
}

export interface FileContextRequest {
  uri: string;
}

export interface FileContextSnapshot {
  filePath: string;
  primaryType: string;
  confidence: number;
  workspaceScope: "active-file" | "open-documents" | "workspace-index";
  reasoningChain: string[];
  suppressedFalsePositives: string[];
  dependencyCounts: {
    internal: number;
    external: number;
  };
  behaviors: Array<{
    type: string;
    confidence: number;
    evidence: string[];
  }>;
  roles: Array<{
    type: string;
    confidence: number;
    evidence: string[];
  }>;
  findings: Array<{
    type: string;
    severity: "info" | "warning" | "error";
    confidence: number;
    description?: string;
    evidence: string[];
  }>;
  functions: Array<{
    stableId: string;
    name?: string;
    kind: "function" | "method" | "arrow-function";
    startLine: number;
    endLine: number;
    parameterNames: string[];
  }>;
  diagnostics: Array<{
    ruleId: string;
    severity: "off" | "warning" | "error" | "info";
    message: string;
    line: number;
    column: number;
  }>;
  liveProjectViolationSummary: {
    sourceScope: "open-documents" | "workspace-index";
    analyzedFileCount: number;
    filesWithViolations: number;
    totalOpen: number;
    countsBySeverity: {
      error: number;
      warning: number;
      info: number;
    };
    countsByRule: Record<string, number>;
  };
}
