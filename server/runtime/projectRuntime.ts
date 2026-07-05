import path from "path";
import fs from "fs";
import crypto from "crypto";
import { gzipSync } from "zlib";
import { fileURLToPath, pathToFileURL } from "url";

import { TextDocument } from "vscode-languageserver-textdocument";

import { parseFileContent } from "../parseFile.js";
import { findProjectRoot, collectProjectSourceFiles } from "../fileScanner.js";
import { normalizeProjectFileKey } from "../fileScanner.js";
import type { CoreAstAnalysisResponse } from "@corrdex/shared/contracts/analysis.js";
import type { CoreAstAnalysisRequest } from "@corrdex/shared/contracts/analysis.js";
import { loadConfig } from "../../loadConfig.js";
import type { ASTMetadata } from "../../parseAST.js";
import type { Diagnostic } from "@corrdex/shared/contracts/analysis.js";
     export type FileClassificationRecord = any;
     export type ProjectAnalysisContext = any;
import type { FileContextSnapshot, SidebarSnapshot, SyncToServerResponse } from "../../extensionProtocol.js";

export type DocumentInsight = {
  uri: string;
  filePath: string;
  fileKey: string;
  diagnostics: Diagnostic[];
  classification?: FileClassificationRecord;
  ast?: ASTMetadata;
  project?: ProjectAnalysisContext;
};

export class ProjectRuntimeStore {
  public onDiagnosticsUpdated?: () => void;
  private workspaceRoots: string[] = [];
  private readonly documentInsights = new Map<string, DocumentInsight>();
  private readonly workspaceInsights = new Map<string, DocumentInsight>();
  private workspaceRebuildTimer: NodeJS.Timeout | null = null;
  private workspaceRebuildPromise: Promise<void> | null = null;
  private workspaceRebuildQueued = false;
  private coreServerBaseUrl = "http://127.0.0.1:3010";
  private readonly lastUploadedAstFingerprintsByProject = new Map<string, Map<string, string>>();
  private readonly lastUploadedConfigFingerprintsByProject = new Map<string, string>();

  setWorkspaceRoots(workspaceRoots: string[]) {
    this.workspaceRoots = workspaceRoots;
  }

  setCoreServerBaseUrl(coreServerBaseUrl: string) {
    this.coreServerBaseUrl = normalizeServerBaseUrl(coreServerBaseUrl);
  }

  clear(uri: string) {
    this.documentInsights.delete(uri);
  }

  clearAll() {
    this.documentInsights.clear();
  }

  async persistWorkspaceIndex(projectId: string, serverBaseUrl: string, apiKey: string): Promise<SyncToServerResponse> {
    let lastError: any = null;
    let result: SyncToServerResponse | null = null;

    for (const workspaceRoot of this.workspaceRoots) {
      try {
        const config = loadConfig(workspaceRoot);
        const policiesPath = path.join(workspaceRoot, "corrdex.policies.json");
        let policies = undefined;
        if (fs.existsSync(policiesPath)) {
          policies = JSON.parse(fs.readFileSync(policiesPath, "utf-8"));
        }

        const files = collectProjectSourceFiles(workspaceRoot);
        const astRegistry = new Map<string, ASTMetadata>();
        for (const filePath of files) {
          const content = fs.readFileSync(filePath, "utf-8");
          const ast = parseFileContent(filePath, content);
          const fileKey = normalizeProjectFileKey(workspaceRoot, path.resolve(filePath));
          astRegistry.set(fileKey, ast);
        }

        const response = await this.pushAstSnapshotToCore(workspaceRoot, astRegistry, config, policies, {
          projectId,
          serverBaseUrl,
          apiKey,
          triggerType: "manual"
        });

        if (response?.persistResult) {
          if (response.persistResult.ok || response.persistResult.indexRun?.ok || response.persistResult.scanRun?.ok) {
            result = {
              ok: response.persistResult.ok,
              message: response.persistResult.message || (response.persistResult.ok ? "Index pushed successfully." : "Partial push success."),
              filesUploaded: response.persistResult.filesUploaded,
              indexRun: response.persistResult.indexRun,
              scanRun: response.persistResult.scanRun
            };
          } else {
            lastError = new Error(response.persistResult.message || "Unknown error from server");
          }
        }
      } catch (err) {
        console.error("Failed to persist workspace:", err);
        lastError = err;
      }
    }

    if (result) return result;
    if (lastError) return { ok: false, message: lastError.message || String(lastError) };
    return { ok: false, message: "No workspaces were synced." };
  }

  requestWorkspaceRebuild(delayMs = 250) {
    if (this.workspaceRebuildTimer) {
      clearTimeout(this.workspaceRebuildTimer);
    }

    this.workspaceRebuildTimer = setTimeout(() => {
      this.workspaceRebuildTimer = null;
      void this.rebuildWorkspaceIndex();
    }, delayMs);
  }

  async rebuildWorkspaceIndex(): Promise<void> {
    if (this.workspaceRebuildPromise) {
      this.workspaceRebuildQueued = true;
      return this.workspaceRebuildPromise;
    }

    this.workspaceRebuildPromise = (async () => {
      const nextWorkspaceInsights = new Map<string, DocumentInsight>();

      for (const workspaceRoot of this.workspaceRoots) {
        if (!fs.existsSync(workspaceRoot)) {
          continue;
        }

        try {
          const config = loadConfig(workspaceRoot);
          const policies = readPolicies(workspaceRoot);
          const astRegistry = new Map<string, ASTMetadata>();
          
          for (const filePath of collectProjectSourceFiles(workspaceRoot)) {
              const content = fs.readFileSync(filePath, "utf8");
              const ast = parseFileContent(filePath, content);
              const fileKey = normalizeProjectFileKey(workspaceRoot, path.resolve(filePath));
              astRegistry.set(fileKey, ast);
          }

          const response = await this.pushAstSnapshotToCore(workspaceRoot, astRegistry, config, policies);
          
          if (response) {
              const diagnosticsByFilePath = groupDiagnosticsByFilePath(response.diagnostics);
              const projectContext = undefined;
              
              for (const fileResult of response.files) {
                  const absoluteFilePath = normalizeInsightKey(fileResult.path);
                  
                  nextWorkspaceInsights.set(absoluteFilePath, {
                      uri: pathToFileURL(absoluteFilePath).toString(),
                      filePath: absoluteFilePath,
                      fileKey: normalizeProjectFileKey(workspaceRoot, absoluteFilePath),
                      diagnostics: diagnosticsByFilePath.get(absoluteFilePath) ?? [],
                      classification: fileResult.classification as any,
                      ast: astRegistry.get(normalizeProjectFileKey(workspaceRoot, absoluteFilePath)),
                      project: projectContext,
                  });
              }
          }
        } catch (err) {
          console.error("Failed to index workspace:", err);
        }
      }

      this.workspaceInsights.clear();
      for (const [filePath, insight] of nextWorkspaceInsights.entries()) {
        this.workspaceInsights.set(filePath, insight);
      }
    })();

    try {
      await this.workspaceRebuildPromise;
    } finally {
      this.workspaceRebuildPromise = null;
      if (this.workspaceRebuildQueued) {
        this.workspaceRebuildQueued = false;
        this.requestWorkspaceRebuild(100);
      }
      this.onDiagnosticsUpdated?.();
    }
  }

  getInsight(uri: string) {
    return this.documentInsights.get(uri);
  }

  updateDocument(textDocument: TextDocument): DocumentInsight {
    const insight = collectDocumentInsight(textDocument, this.workspaceRoots);
    const existing = this.workspaceInsights.get(insight.filePath);
    if (existing && existing.diagnostics) {
      insight.diagnostics = existing.diagnostics;
    }
    this.documentInsights.set(textDocument.uri, insight);
    return insight;
  }

  getOrUpdateDocument(textDocument: TextDocument): DocumentInsight {
    return this.documentInsights.get(textDocument.uri) ?? this.updateDocument(textDocument);
  }

  getSidebarSnapshot(textDocument: TextDocument): SidebarSnapshot | null {
    const insight = this.getOrUpdateDocument(textDocument);
    if (!insight.classification) {
      return null;
    }

    return buildSidebarSnapshot(insight);
  }

  getFileContextSnapshot(textDocument: TextDocument): FileContextSnapshot | null {
    const insight = this.getOrUpdateDocument(textDocument);
    if (!insight.classification) {
      return null;
    }

    return buildFileContextSnapshot(insight, this.getMergedInsights(insight), this.workspaceInsights.size > 0);
  }

  private getMergedInsights(currentInsight: DocumentInsight): DocumentInsight[] {
    const merged = new Map<string, DocumentInsight>();

    for (const [filePath, insight] of this.workspaceInsights.entries()) {
      merged.set(filePath, insight);
    }

    for (const insight of this.documentInsights.values()) {
      merged.set(normalizeInsightKey(insight.filePath), insight);
    }

    merged.set(normalizeInsightKey(currentInsight.filePath), currentInsight);
    return [...merged.values()];
  }

  private async pushAstSnapshotToCore(
    projectRoot: string,
    astRegistry: Map<string, ASTMetadata>,
    config: ReturnType<typeof loadConfig>,
    policies?: any[],
    persistOptions?: { projectId: string; serverBaseUrl: string; apiKey: string; triggerType: "manual" | "file-save" | "watch" | "ci" | "staged" | "branch" }
  ): Promise<CoreAstAnalysisResponse | null> {
    if (!this.coreServerBaseUrl) {
      throw new Error("Local corrdexcore serverBaseUrl is not configured. Is corrdex.core.serverBaseUrl set?");
    }
    if (astRegistry.size === 0) {
      throw new Error("No source files found in the workspace to sync.");
    }

    const normalizedProjectRoot = normalizeInsightKey(projectRoot);
    const previousFingerprints = this.lastUploadedAstFingerprintsByProject.get(normalizedProjectRoot);
    const nextFingerprints = new Map<string, string>();
    const allFiles = [...astRegistry.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fileKey, ast]) => ({
        path: path.resolve(projectRoot, fileKey),
        ast,
      }));
    const changedFiles: CoreAstAnalysisRequest["files"] = [];

    for (const file of allFiles) {
      const fingerprint = fingerprintAst(file.ast);
      nextFingerprints.set(file.path, fingerprint);

      if (!previousFingerprints || previousFingerprints.get(file.path) !== fingerprint) {
        changedFiles.push(file);
      }
    }

    const deletedFiles = previousFingerprints
      ? [...previousFingerprints.keys()]
          .filter((filePath) => !nextFingerprints.has(filePath))
          .sort((left, right) => left.localeCompare(right))
      : [];

    const configFingerprint = fingerprintConfig(config) + "_" + (policies ? crypto.createHash("sha256").update(JSON.stringify(policies)).digest("hex") : "");
    const configChanged = this.lastUploadedConfigFingerprintsByProject.get(normalizedProjectRoot) !== configFingerprint;
    const syncMode = (previousFingerprints && !persistOptions) ? "delta" : "full";

    if (syncMode === "delta" && changedFiles.length === 0 && deletedFiles.length === 0 && !configChanged) {
      return null;
    }

    const payload: CoreAstAnalysisRequest = {
      projectRoot,
      files: syncMode === "full" ? allFiles : changedFiles,
      deletedFiles,
      syncMode,
      config,
      policies,
      ...(persistOptions ? {
        persist: true,
        projectId: persistOptions.projectId,
        serverBaseUrl: persistOptions.serverBaseUrl,
        apiKey: persistOptions.apiKey,
        triggerType: persistOptions.triggerType,
      } : {})
    };

    try {
      let response = await postAstSyncRequest(this.coreServerBaseUrl, payload);

      if (response.status === 409 && syncMode === "delta") {
        response = await postAstSyncRequest(this.coreServerBaseUrl, {
          projectRoot,
          files: allFiles,
          syncMode: "full",
          config,
          policies,
          ...(persistOptions ? {
            persist: true,
            projectId: persistOptions.projectId,
            serverBaseUrl: persistOptions.serverBaseUrl,
            apiKey: persistOptions.apiKey,
            triggerType: persistOptions.triggerType,
          } : {})
        });
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        const errMsg = `Corrdex core AST sync failed: ${response.status} ${errText}`.trim();
        console.warn(errMsg);
        if (persistOptions) {
          throw new Error(errMsg);
        }
        return null;
      }

      this.lastUploadedAstFingerprintsByProject.set(normalizedProjectRoot, nextFingerprints);
      this.lastUploadedConfigFingerprintsByProject.set(normalizedProjectRoot, configFingerprint);
      return await response.json();
    } catch (e: any) {
      if (persistOptions) {
        throw e;
      }
      return null;
    }
  }
}

function normalizeServerBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}

async function postAstSyncRequest(
  coreServerBaseUrl: string,
  payload: CoreAstAnalysisRequest,
): Promise<Response> {
  const url = `${coreServerBaseUrl}/v1/analyze/ast`;
  const body = JSON.stringify(payload);

  let response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: gzipSync(Buffer.from(body, "utf8")),
  });

  if (isAstSyncCompressionRetryStatus(response.status)) {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body,
    });
  }

  return response;
}

function isAstSyncCompressionRetryStatus(status: number): boolean {
  return status === 400 || status === 415;
}

function fingerprintAst(ast: ASTMetadata): string {
  return crypto.createHash("sha256").update(JSON.stringify(ast)).digest("hex");
}

function fingerprintConfig(config: ReturnType<typeof loadConfig>): string {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function collectDocumentInsight(
  textDocument: TextDocument,
  workspaceRoots: string[],
): DocumentInsight {
  const text = textDocument.getText();
  const filePath = resolveFilePathFromUri(textDocument.uri);
  const ast = parseFileContent(filePath, text);
  const root = resolveConfigRoot(filePath, workspaceRoots);
  const fileKey = normalizeProjectFileKey(root, filePath);

  return {
    uri: textDocument.uri,
    filePath,
    fileKey,
    diagnostics: [], // Diagnostics will be populated async from core
    ast,
  };
}

function buildSidebarSnapshot(insight: DocumentInsight): SidebarSnapshot {
  const classification = insight.classification!;

  return {
    filePath: insight.filePath,
    primaryType: classification.primaryType,
    confidence: classification.confidence,
    dependencyCounts: {
      internal: classification.dependencyProfile.internal.length,
      external: classification.dependencyProfile.external.length,
    },
    behaviors: [...classification.behaviors]
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 8)
      .map((behavior: any) => ({
        type: behavior.type,
        confidence: behavior.confidence,
        evidence: behavior.evidence.map((entry: any) => entry.signal),
      })),
    roles: [...(classification.architecturalRoles ?? [])]
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 6)
      .map((role: any) => ({
        type: role.type,
        confidence: role.confidence,
        evidence: [...role.evidence],
      })),
    findings: classification.architecturalFindings
      .slice(0, 8)
      .map((finding: any) => ({
        type: finding.type,
        severity: finding.severity,
        confidence: finding.confidence,
        ...(finding.description ? { description: finding.description } : {}),
        evidence: [...(finding.evidence ?? [])],
      })),
    diagnostics: [...insight.diagnostics]
      .sort((left, right) => {
        if (left.line !== right.line) {
          return left.line - right.line;
        }
        return left.column - right.column;
      })
      .map((diagnostic: any) => ({
        ruleId: diagnostic.ruleId,
        severity: diagnostic.severity,
        message: diagnostic.message,
        line: diagnostic.line,
        column: diagnostic.column,
      })),
  };
}

function buildFileContextSnapshot(
  insight: DocumentInsight,
  allInsights: DocumentInsight[],
  hasWorkspaceIndex: boolean,
): FileContextSnapshot {
  const classification = insight.classification!;
  const liveProjectViolationSummary = buildLiveProjectViolationSummary(insight, allInsights, hasWorkspaceIndex);

  return {
    filePath: insight.filePath,
    primaryType: classification.primaryType,
    confidence: classification.confidence,
    workspaceScope: hasWorkspaceIndex ? "workspace-index" : "open-documents",
    reasoningChain: [...classification.reasoningChain].slice(0, 20),
    suppressedFalsePositives: [...classification.suppressedFalsePositives],
    dependencyCounts: {
      internal: classification.dependencyProfile.internal.length,
      external: classification.dependencyProfile.external.length,
    },
    behaviors: [...classification.behaviors]
      .sort((left, right) => right.confidence - left.confidence)
      .map((behavior: any) => ({
        type: behavior.type,
        confidence: behavior.confidence,
        evidence: behavior.evidence.map((entry: any) => entry.signal).slice(0, 5),
      })),
    roles: [...(classification.architecturalRoles ?? [])]
      .sort((left, right) => right.confidence - left.confidence)
      .map((role: any) => ({
        type: role.type,
        confidence: role.confidence,
        evidence: [...role.evidence],
      })),
    findings: classification.architecturalFindings.map((finding: any) => ({
      type: finding.type,
      severity: finding.severity,
      confidence: finding.confidence,
      ...(finding.description ? { description: finding.description } : {}),
      evidence: [...(finding.evidence ?? [])],
    })),
    functions: classification.functions.map((block: any) => ({
      stableId: block.stableId,
      ...(block.name ? { name: block.name } : {}),
      kind: block.kind,
      startLine: block.startLine,
      endLine: block.endLine,
      parameterNames: [...block.parameterNames],
    })),
    diagnostics: [...insight.diagnostics]
      .sort((left, right) => {
        if (left.line !== right.line) {
          return left.line - right.line;
        }
        return left.column - right.column;
      })
      .map((diagnostic: any) => ({
        ruleId: diagnostic.ruleId,
        severity: diagnostic.severity,
        message: diagnostic.message,
        line: diagnostic.line,
        column: diagnostic.column,
      })),
    liveProjectViolationSummary,
  };
}

function buildLiveProjectViolationSummary(
  currentInsight: DocumentInsight,
  allInsights: DocumentInsight[],
  hasWorkspaceIndex: boolean,
) {
  const countsBySeverity = {
    error: 0,
    warning: 0,
    info: 0,
  };
  const countsByRule = new Map<string, number>();
  const sourceInsights = allInsights.length > 0 ? allInsights : [currentInsight];
  let totalOpen = 0;
  let filesWithViolations = 0;

  for (const insight of sourceInsights) {
    if (insight.diagnostics.length > 0) {
      filesWithViolations += 1;
    }

    for (const diagnostic of insight.diagnostics) {
      totalOpen += 1;

      if (diagnostic.severity === "error") {
        countsBySeverity.error += 1;
      } else if (diagnostic.severity === "warning") {
        countsBySeverity.warning += 1;
      } else if (diagnostic.severity === "info") {
        countsBySeverity.info += 1;
      }

      countsByRule.set(diagnostic.ruleId, (countsByRule.get(diagnostic.ruleId) ?? 0) + 1);
    }
  }

  return {
    sourceScope: hasWorkspaceIndex ? ("workspace-index" as const) : ("open-documents" as const),
    analyzedFileCount: sourceInsights.length,
    filesWithViolations,
    totalOpen,
    countsBySeverity,
    countsByRule: Object.fromEntries(
      [...countsByRule.entries()].sort((left, right) => right[1] - left[1]),
    ),
  };
}

function groupDiagnosticsByFilePath(diagnostics: Diagnostic[]): Map<string, Diagnostic[]> {
  const diagnosticsByFilePath = new Map<string, Diagnostic[]>();

  for (const diagnostic of diagnostics) {
    const filePath = normalizeInsightKey(diagnostic.file);
    const bucket = diagnosticsByFilePath.get(filePath);
    if (bucket) {
      bucket.push(diagnostic);
      continue;
    }
    diagnosticsByFilePath.set(filePath, [diagnostic]);
  }

  return diagnosticsByFilePath;
}

function normalizeInsightKey(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function resolveFilePathFromUri(uri: string): string {
  let filePath = uri;
  try {
    if (uri.startsWith("file://")) {
      filePath = fileURLToPath(uri);
    }
  } catch {
    // Ignore malformed URI and fall back to raw value.
  }
  return filePath;
}

function resolveConfigRoot(filePath: string, workspaceRoots: string[]): string {
  const matchingRoot = workspaceRoots
    .filter((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`))
    .sort((left, right) => right.length - left.length)[0];

  if (matchingRoot) {
    return matchingRoot;
  }

  return path.dirname(filePath);
}

function normalizeProjectRelativePath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, path.resolve(filePath)).replace(/\\/g, "/");
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

function readPolicies(projectRoot: string): any[] | undefined {
  const policiesPath = path.join(projectRoot, "corrdex.policies.json");
  if (!fs.existsSync(policiesPath)) {
    return undefined;
  }
  try {
    const policiesContent = fs.readFileSync(policiesPath, "utf-8");
    const policiesJson = JSON.parse(policiesContent);
    return Array.isArray(policiesJson) ? policiesJson : (policiesJson.policies || []);
  } catch (err) {
    console.warn(`Failed to parse policies from ${policiesPath}`, err);
    return undefined;
  }
}
