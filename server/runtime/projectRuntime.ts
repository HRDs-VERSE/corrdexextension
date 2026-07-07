import path from "path";
import fs from "fs";
import crypto from "crypto";
import { gzipSync } from "zlib";
import { fileURLToPath, pathToFileURL } from "url";

import { TextDocument } from "vscode-languageserver-textdocument";

import { parseFileContent } from "../parseFile.js";
import { findProjectRoot, collectProjectSourceFiles } from "../fileScanner.js";
import { normalizeProjectFileKey } from "../fileScanner.js";
import { parsePythonASTBatch } from "../../parsePythonAST.js";
import type { CoreAstAnalysisResponse } from "@corrdex/shared/contracts/analysis.js";
import type { CoreAstAnalysisRequest } from "@corrdex/shared/contracts/analysis.js";
import type { CoreAstAnalysisFilePayload } from "@corrdex/shared/contracts/analysis.js";
import type { ProjectBlobChunkUploadRequest } from "@corrdex/shared/contracts/analysis.js";
import type { ProjectBlobUploadItem } from "@corrdex/shared/contracts/analysis.js";
import type { ProjectSyncBootstrapRequest } from "@corrdex/shared/contracts/analysis.js";
import type { ProjectSyncCompleteRequest } from "@corrdex/shared/contracts/analysis.js";
import type { ProjectSyncManifestFile } from "@corrdex/shared/contracts/analysis.js";
import type { ProjectSyncManifestRequest } from "@corrdex/shared/contracts/analysis.js";
import type { ProjectSyncManifestResponse } from "@corrdex/shared/contracts/analysis.js";
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

type SourceFileSnapshot = {
  files: CoreAstAnalysisFilePayload[];
  manifestFiles: ProjectSyncManifestFile[];
  contentByHash: Map<string, string>;
};

type CoreSyncPackUploadTarget = {
  uploadId: string;
  objectKey: string;
  uploadUrl: string;
  downloadUrl: string;
  expiresInSeconds: number;
  headers?: Record<string, string>;
  targets?: CoreSyncPackUploadTarget[];
  partCount?: number;
};

type ProjectSyncBootstrapPayload = ProjectSyncBootstrapRequest & {
  packDownloadUrls?: string[];
};

const BOOTSTRAP_PACK_FILE_THRESHOLD = 1000;
const BOOTSTRAP_PACK_MAX_FILES_PER_PART = 400;
const S3_UPLOAD_MAX_RETRIES = 3;

export class ProjectRuntimeStore {
  public onDiagnosticsUpdated?: () => void;
  private workspaceRoots: string[] = [];
  private readonly documentInsights = new Map<string, DocumentInsight>();
  private readonly workspaceInsights = new Map<string, DocumentInsight>();
  private workspaceRebuildTimer: NodeJS.Timeout | null = null;
  private workspaceRebuildPromise: Promise<void> | null = null;
  private workspaceRebuildQueued = false;
  private syncInFlightPromise: Promise<SyncToServerResponse> | null = null;
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
    if (this.syncInFlightPromise) {
      return this.syncInFlightPromise;
    }

    this.syncInFlightPromise = this.runPersistWorkspaceIndex(projectId, serverBaseUrl, apiKey);
    try {
      return await this.syncInFlightPromise;
    } finally {
      this.syncInFlightPromise = null;
    }
  }

  private async runPersistWorkspaceIndex(projectId: string, serverBaseUrl: string, apiKey: string): Promise<SyncToServerResponse> {
    let lastError: any = null;
    let result: SyncToServerResponse | null = null;

    for (const workspaceRoot of this.workspaceRoots) {
      try {
        const syncStartedAt = Date.now();
        const config = loadConfig(workspaceRoot);
        const policiesPath = path.join(workspaceRoot, "corrdex.policies.json");
        let policies = undefined;
        if (fs.existsSync(policiesPath)) {
          policies = JSON.parse(fs.readFileSync(policiesPath, "utf-8"));
        }

        const fileScanStartedAt = Date.now();
        const files = collectProjectSourceFiles(workspaceRoot);
        console.log(`[Corrdex] Sync file scan complete files=${files.length} durationMs=${Date.now() - fileScanStartedAt}`);
        const normalizedProjectRoot = normalizeInsightKey(workspaceRoot);
        const previousFingerprints = this.lastUploadedAstFingerprintsByProject.get(normalizedProjectRoot);

        if (!previousFingerprints && files.length > BOOTSTRAP_PACK_FILE_THRESHOLD) {
          console.log(`[Corrdex] Sync bootstrap path selected files=${files.length} threshold=${BOOTSTRAP_PACK_FILE_THRESHOLD}`);
          const bootstrapStartedAt = Date.now();
          const bootstrapResponse = await this.pushBootstrapPackToServer(workspaceRoot, files, config, policies, {
            projectId,
            serverBaseUrl,
            apiKey,
            triggerType: "manual",
          });
          console.log(`[Corrdex] Sync bootstrap upload complete durationMs=${Date.now() - bootstrapStartedAt}`);

          if (bootstrapResponse?.persistResult) {
            if (bootstrapResponse.persistResult.ok || bootstrapResponse.persistResult.indexRun?.ok || bootstrapResponse.persistResult.scanRun?.ok) {
              result = {
                ok: bootstrapResponse.persistResult.ok,
                message: bootstrapResponse.persistResult.message || (bootstrapResponse.persistResult.ok ? "Index pushed successfully." : "Partial push success."),
                filesUploaded: bootstrapResponse.persistResult.filesUploaded,
                jobId: typeof (bootstrapResponse.persistResult as unknown as { jobId?: unknown }).jobId === "string"
                  ? (bootstrapResponse.persistResult as unknown as { jobId: string }).jobId
                  : undefined,
                indexRun: bootstrapResponse.persistResult.indexRun,
                scanRun: bootstrapResponse.persistResult.scanRun
              };
              console.log(`[Corrdex] Sync request finished totalDurationMs=${Date.now() - syncStartedAt}`);
            } else {
              lastError = new Error(bootstrapResponse.persistResult.message || "Unknown error from server");
            }
          } else if (bootstrapResponse) {
            lastError = new Error("Corrdex core response missing persistResult for bootstrap sync request.");
          }
          continue;
        }

        const sourceSnapshotStartedAt = Date.now();
        const sourceSnapshot = buildSourceFileSnapshot(files);
        console.log(`[Corrdex] Sync source snapshot complete files=${sourceSnapshot.files.length} durationMs=${Date.now() - sourceSnapshotStartedAt}`);

        const uploadStartedAt = Date.now();
        const response = await this.pushSourceSnapshotToCore(workspaceRoot, sourceSnapshot, config, policies, {
          projectId,
          serverBaseUrl,
          apiKey,
          triggerType: "manual"
        });
        console.log(`[Corrdex] Sync core upload complete durationMs=${Date.now() - uploadStartedAt}`);

        if (!response) {
          result = result ?? {
            ok: true,
            message: "No changes to sync.",
            filesUploaded: 0,
          };
          console.log(`[Corrdex] Sync skipped because there were no changed files totalDurationMs=${Date.now() - syncStartedAt}`);
        } else if (response.persistResult) {
          if (response.persistResult.ok || response.persistResult.indexRun?.ok || response.persistResult.scanRun?.ok) {
            result = {
              ok: response.persistResult.ok,
              message: response.persistResult.message || (response.persistResult.ok ? "Index pushed successfully." : "Partial push success."),
              filesUploaded: response.persistResult.filesUploaded,
              indexRun: response.persistResult.indexRun,
              scanRun: response.persistResult.scanRun
            };
            console.log(`[Corrdex] Sync request finished totalDurationMs=${Date.now() - syncStartedAt}`);
          } else {
            lastError = new Error(response.persistResult.message || "Unknown error from server");
          }
        } else if (response) {
          lastError = new Error("Corrdex core response missing persistResult for sync request.");
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
          const sourceFiles = collectProjectSourceFiles(workspaceRoot);
          const pythonFiles = sourceFiles.filter((filePath) => filePath.endsWith(".py"));
          const pythonAstByPath = new Map<string, ASTMetadata>();

          if (pythonFiles.length > 0) {
            try {
              const parsedPythonFiles = parsePythonASTBatch(pythonFiles);
              for (const [filePath, ast] of Object.entries(parsedPythonFiles)) {
                pythonAstByPath.set(path.resolve(filePath), ast);
              }
            } catch (error) {
              console.warn(
                `[Corrdex] Workspace rebuild Python batch parse failed files=${pythonFiles.length} error=${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }

          for (const filePath of sourceFiles) {
              const absoluteFilePath = path.resolve(filePath);
              const content = fs.readFileSync(absoluteFilePath, "utf8");
              const ast = filePath.endsWith(".py")
                ? applyContentHashToAst(
                    pythonAstByPath.get(absoluteFilePath) ?? buildEmptyAst(),
                    content,
                  )
                : parseFileContent(absoluteFilePath, content);
              const fileKey = normalizeProjectFileKey(workspaceRoot, absoluteFilePath);
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
    const syncMode = previousFingerprints ? "delta" : "full";

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
      let response = await postAstSyncChunked(this.coreServerBaseUrl, payload);

      if (response.status === 409 && syncMode === "delta") {
        response = await postAstSyncChunked(this.coreServerBaseUrl, {
          projectRoot,
          files: allFiles,
          syncMode: "full",
          deletedFiles,
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

  private async pushSourceSnapshotToCore(
    projectRoot: string,
    sourceSnapshot: SourceFileSnapshot,
    config: ReturnType<typeof loadConfig>,
    policies?: any[],
    persistOptions?: { projectId: string; serverBaseUrl: string; apiKey: string; triggerType: "manual" | "file-save" | "watch" | "ci" | "staged" | "branch" }
  ): Promise<CoreAstAnalysisResponse | null> {
    if (!this.coreServerBaseUrl) {
      throw new Error("Local corrdexcore serverBaseUrl is not configured. Is corrdex.core.serverBaseUrl set?");
    }
    if (sourceSnapshot.files.length === 0) {
      throw new Error("No source files found in the workspace to sync.");
    }

    const normalizedProjectRoot = normalizeInsightKey(projectRoot);
    const previousFingerprints = this.lastUploadedAstFingerprintsByProject.get(normalizedProjectRoot);
    const nextFingerprints = new Map<string, string>();
    const allFiles = [...sourceSnapshot.files]
      .sort((left, right) => left.path.localeCompare(right.path));
    const changedFiles: CoreAstAnalysisRequest["files"] = [];

    for (const file of allFiles) {
      const fingerprint = fingerprintAnalysisFile(file);
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
    const syncMode = previousFingerprints ? "delta" : "full";

    if (syncMode === "delta" && changedFiles.length === 0 && deletedFiles.length === 0 && !configChanged) {
      return null;
    }

    const manifestPayload: ProjectSyncManifestRequest = {
      projectId: persistOptions?.projectId ?? normalizedProjectRoot,
      projectRoot,
      files: sourceSnapshot.manifestFiles,
      deletedFiles,
      syncMode,
      config,
      policies,
      ...(persistOptions ? {
        persist: true,
        serverBaseUrl: persistOptions.serverBaseUrl,
        apiKey: persistOptions.apiKey,
        triggerType: persistOptions.triggerType,
      } : {})
    };

    try {
      console.log(`[Corrdex] Sync manifest request start files=${sourceSnapshot.manifestFiles.length} deleted=${deletedFiles.length} syncMode=${syncMode}`);
      let manifestResponse = await postProjectSyncManifest(this.coreServerBaseUrl, manifestPayload);

      if (manifestResponse.status === 409 && syncMode === "delta") {
        console.log("[Corrdex] Sync manifest requested full resync; retrying as full");
        manifestResponse = await postProjectSyncManifest(this.coreServerBaseUrl, {
          ...manifestPayload,
          syncMode: "full",
        });
      }

      if (!manifestResponse.ok) {
        const errText = await manifestResponse.text().catch(() => "");
        const errMsg = `Corrdex core manifest sync failed: ${manifestResponse.status} ${errText}`.trim();
        console.warn(errMsg);
        if (persistOptions) {
          throw new Error(errMsg);
        }
        return null;
      }

      const manifestResult = await manifestResponse.json() as ProjectSyncManifestResponse;
      console.log(
        `[Corrdex] Sync manifest accepted snapshot=${manifestResult.snapshotId} changed=${manifestResult.changedFileCount} deleted=${manifestResult.deletedFileCount} neededHashes=${manifestResult.neededHashes.length} neededBytes=${manifestResult.neededBytes} uploadMode=${manifestResult.uploadMode} syncMode=${manifestResult.syncMode}`,
      );
      const neededHashes = new Set(manifestResult.neededHashes);

      if (neededHashes.size > 0) {
        const blobs = [...neededHashes]
          .map((contentHash) => {
            const content = sourceSnapshot.contentByHash.get(contentHash);
            if (typeof content !== "string") {
              throw new Error(`Missing local content for requested hash: ${contentHash}`);
            }
            return { contentHash, content };
          });

        if (manifestResult.uploadMode === "s3-pack") {
          if (!persistOptions) {
            throw new Error("S3 pack upload mode requires remote persist options.");
          }

          console.log(`[Corrdex] Sync pack upload start snapshot=${manifestResult.snapshotId} blobs=${blobs.length}`);
          const packTarget = await startCoreSyncPackUpload(persistOptions.serverBaseUrl, persistOptions.projectId, persistOptions.apiKey);
          await uploadProjectSyncPackToS3(packTarget, blobs);
          console.log(`[Corrdex] Sync pack upload complete snapshot=${manifestResult.snapshotId} uploadId=${packTarget.uploadId}`);
          console.log(`[Corrdex] Sync finalize start snapshot=${manifestResult.snapshotId}`);
          const response = await completeProjectBlobSync(this.coreServerBaseUrl, manifestResult.snapshotId, {
            packDownloadUrl: packTarget.downloadUrl,
          });
          if (!response.ok) {
            const errText = await response.text().catch(() => "");
            const errMsg = `Corrdex core blob sync failed: ${response.status} ${errText}`.trim();
            console.warn(errMsg);
            if (persistOptions) {
              throw new Error(errMsg);
            }
            return null;
          }
          console.log(`[Corrdex] Sync finalize complete snapshot=${manifestResult.snapshotId} status=${response.status}`);
          this.lastUploadedAstFingerprintsByProject.set(normalizedProjectRoot, nextFingerprints);
          this.lastUploadedConfigFingerprintsByProject.set(normalizedProjectRoot, configFingerprint);
          return await response.json();
        }

        console.log(`[Corrdex] Sync blob upload start snapshot=${manifestResult.snapshotId} blobs=${blobs.length}`);
        await postProjectBlobsChunked(this.coreServerBaseUrl, manifestResult.snapshotId, blobs);
        console.log(`[Corrdex] Sync blob upload complete snapshot=${manifestResult.snapshotId} blobs=${blobs.length}`);
      } else {
        console.log(`[Corrdex] Sync blob upload skipped snapshot=${manifestResult.snapshotId} reason=no-missing-hashes`);
      }

      console.log(`[Corrdex] Sync finalize start snapshot=${manifestResult.snapshotId}`);
      const response = await completeProjectBlobSync(this.coreServerBaseUrl, manifestResult.snapshotId);
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        const errMsg = `Corrdex core blob sync failed: ${response.status} ${errText}`.trim();
        console.warn(errMsg);
        if (persistOptions) {
          throw new Error(errMsg);
        }
        return null;
      }
      console.log(`[Corrdex] Sync finalize complete snapshot=${manifestResult.snapshotId} status=${response.status}`);

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

  private async pushBootstrapPackToServer(
    projectRoot: string,
    files: string[],
    config: ReturnType<typeof loadConfig>,
    policies?: any[],
    persistOptions?: { projectId: string; serverBaseUrl: string; apiKey: string; triggerType: "manual" | "file-save" | "watch" | "ci" | "staged" | "branch" }
  ): Promise<CoreAstAnalysisResponse | null> {
    if (!this.coreServerBaseUrl) {
      throw new Error("Local corrdexcore serverBaseUrl is not configured. Is corrdex.core.serverBaseUrl set?");
    }
    if (!persistOptions) {
      throw new Error("Bootstrap sync requires remote persist options.");
    }

    const nextFingerprints = new Map<string, string>();
    const packFiles: CoreAstAnalysisRequest["files"] = files
      .map((filePath) => {
        const absoluteFilePath = path.resolve(filePath);
        const content = fs.readFileSync(absoluteFilePath, "utf-8");
        const contentHash = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
        nextFingerprints.set(absoluteFilePath, contentHash);
        return {
          path: absoluteFilePath,
          content,
          contentHash,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    const packChunks = chunkArray(packFiles, BOOTSTRAP_PACK_MAX_FILES_PER_PART);
    const packTarget = await startCoreSyncPackUpload(
      persistOptions.serverBaseUrl,
      persistOptions.projectId,
      persistOptions.apiKey,
      packChunks.length,
    );
    const packTargets = (Array.isArray(packTarget.targets) && packTarget.targets.length > 0
      ? packTarget.targets
      : [packTarget]
    ).map((target) => ({
      ...target,
      uploadId: target.uploadId ?? packTarget.uploadId,
    }));
    console.log(
      `[Corrdex] Sync bootstrap pack upload start files=${packFiles.length} uploadId=${packTarget.uploadId} packs=${packTargets.length}`,
    );

    for (let index = 0; index < packTargets.length; index += 1) {
      const packTargetPart = packTargets[index];
      const packFilesPart = packChunks[index] ?? [];
      await uploadJsonPackToS3(
        packTargetPart,
        { files: packFilesPart },
        `bootstrap-pack-${index + 1}/${packTargets.length}`,
      );
      console.log(
        `[Corrdex] Sync bootstrap pack upload part complete uploadId=${packTarget.uploadId} part=${index + 1}/${packTargets.length} files=${packFilesPart.length}`,
      );
    }

    console.log(`[Corrdex] Sync bootstrap pack upload complete files=${packFiles.length} uploadId=${packTarget.uploadId} packs=${packTargets.length}`);

    const response = await completeCoreSyncPackUpload(
      persistOptions.serverBaseUrl,
      persistOptions.projectId,
      persistOptions.apiKey,
      packTarget.uploadId,
      {
        projectId: persistOptions.projectId,
        projectRoot,
        packDownloadUrl: packTarget.downloadUrl,
        packDownloadUrls: packTargets.map((target) => target.downloadUrl),
        coreServerBaseUrl: this.coreServerBaseUrl,
        serverBaseUrl: persistOptions.serverBaseUrl,
        config,
        policies,
        triggerType: persistOptions.triggerType,
        filesUploaded: packFiles.length,
      },
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Corrdex server bootstrap completion failed: ${response.status} ${errText}`.trim());
    }

    const normalizedProjectRoot = normalizeInsightKey(projectRoot);
    this.lastUploadedAstFingerprintsByProject.set(normalizedProjectRoot, nextFingerprints);
    this.lastUploadedConfigFingerprintsByProject.set(
      normalizedProjectRoot,
      fingerprintConfig(config) + "_" + (policies ? crypto.createHash("sha256").update(JSON.stringify(policies)).digest("hex") : ""),
    );

    return await response.json();
  }
}

function normalizeServerBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}

async function postAstSyncChunked(
  coreServerBaseUrl: string,
  payload: CoreAstAnalysisRequest,
): Promise<Response> {
  const CHUNK_SIZE = 500;
  const CHUNK_CONCURRENCY = 4;
  const localCoreUpload = isLocalCoreUrl(coreServerBaseUrl);
  const files = payload.files;
  const totalChunks = Math.ceil(files.length / CHUNK_SIZE) || 1;

  const startPayload = {
    ...payload,
    files: undefined, // don't send files in start
    totalChunks,
  };

  let startRes = await fetch(`${coreServerBaseUrl}/v1/analyze/ast/upload/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(startPayload),
  });

  if (startRes.status === 409 && payload.syncMode === "delta") {
    return startRes;
  }
  if (!startRes.ok) return startRes;
  
  const startData = await startRes.json();
  const uploadId = startData.uploadId;
  if (!uploadId) throw new Error("Server did not return an uploadId");

  if (files.length === 0) {
    const chunkRes = await sendChunk(coreServerBaseUrl, uploadId, 0, [], localCoreUpload);
    if (!chunkRes.ok) return chunkRes;
  } else {
    for (let batchStart = 0; batchStart < totalChunks; batchStart += CHUNK_CONCURRENCY) {
      const batchChunkIndexes = Array.from(
        { length: Math.min(CHUNK_CONCURRENCY, totalChunks - batchStart) },
        (_, index) => batchStart + index,
      );

      const batchResponses = await Promise.all(
        batchChunkIndexes.map((chunkIndex) => {
          const chunk = files.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE);
          return sendChunk(coreServerBaseUrl, uploadId, chunkIndex, chunk, localCoreUpload);
        }),
      );

      const failedResponse = batchResponses.find((response) => !response.ok);
      if (failedResponse) {
        return failedResponse;
      }
    }
  }

  return fetch(`${coreServerBaseUrl}/v1/analyze/ast/upload/${uploadId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function postProjectSyncManifest(
  coreServerBaseUrl: string,
  payload: ProjectSyncManifestRequest,
): Promise<Response> {
  return fetch(`${coreServerBaseUrl}/v1/sync/manifest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function postProjectBlobsChunked(
  coreServerBaseUrl: string,
  snapshotId: string,
  blobs: ProjectBlobUploadItem[],
): Promise<void> {
  const CHUNK_SIZE = 100;
  const CHUNK_CONCURRENCY = 4;
  const localCoreUpload = isLocalCoreUrl(coreServerBaseUrl);
  const totalChunks = Math.ceil(blobs.length / CHUNK_SIZE) || 1;

  if (blobs.length === 0) {
    return;
  }

  for (let batchStart = 0; batchStart < totalChunks; batchStart += CHUNK_CONCURRENCY) {
    const batchChunkIndexes = Array.from(
      { length: Math.min(CHUNK_CONCURRENCY, totalChunks - batchStart) },
      (_, index) => batchStart + index,
    );

    console.log(
      `[Corrdex] Sync blob batch start snapshot=${snapshotId} batchStart=${batchStart + 1} chunkCount=${batchChunkIndexes.length} totalChunks=${totalChunks}`,
    );

    const batchResponses = await Promise.all(
      batchChunkIndexes.map((chunkIndex) => {
        const chunk = blobs.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE);
        return sendBlobChunk(coreServerBaseUrl, snapshotId, chunk, localCoreUpload);
      }),
    );

    const failedResponse = batchResponses.find((response) => !response.ok);
    if (failedResponse) {
      const errText = await failedResponse.text().catch(() => "");
      throw new Error(`Corrdex core blob chunk upload failed: ${failedResponse.status} ${errText}`.trim());
    }

    console.log(
      `[Corrdex] Sync blob batch complete snapshot=${snapshotId} batchStart=${batchStart + 1} chunkCount=${batchChunkIndexes.length} totalChunks=${totalChunks}`,
    );
  }
}

async function completeProjectBlobSync(
  coreServerBaseUrl: string,
  snapshotId: string,
  payload?: ProjectSyncCompleteRequest,
): Promise<Response> {
  return fetch(`${coreServerBaseUrl}/v1/sync/blobs/${snapshotId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

async function startCoreSyncPackUpload(
  serverBaseUrl: string,
  projectId: string,
  apiKey: string,
  partCount = 1,
): Promise<CoreSyncPackUploadTarget> {
  const response = await fetch(`${normalizeServerBaseUrl(serverBaseUrl)}/v1/projects/${encodeURIComponent(projectId)}/core-sync-pack/uploads/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ partCount }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Failed to start core sync pack upload: ${response.status} ${errText}`.trim());
  }

  return await response.json() as CoreSyncPackUploadTarget;
}

async function uploadProjectSyncPackToS3(
  target: CoreSyncPackUploadTarget,
  blobs: ProjectBlobUploadItem[],
): Promise<void> {
  await uploadJsonPackToS3(target, { blobs } satisfies ProjectBlobChunkUploadRequest);
}

async function uploadJsonPackToS3(
  target: CoreSyncPackUploadTarget,
  payload: unknown,
  label = "sync-pack",
): Promise<void> {
  const body = JSON.stringify(payload);
  const compressedBody = gzipSync(Buffer.from(body, "utf8"));
  console.log(
    `[Corrdex] S3 pack upload start label=${label} uploadId=${target.uploadId} raw=${Buffer.byteLength(body, "utf8")}B gzip=${compressedBody.length}B`,
  );

  for (let attempt = 1; attempt <= S3_UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      const requestHeaders = target.headers && Object.keys(target.headers).length > 0
        ? target.headers
        : {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
          };
      const response = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: requestHeaders,
        body: compressedBody,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Failed to upload sync pack to S3: ${response.status} ${errText}`.trim());
      }

      console.log(`[Corrdex] S3 pack upload complete label=${label} uploadId=${target.uploadId} attempt=${attempt}`);
      return;
    } catch (error) {
      if (attempt >= S3_UPLOAD_MAX_RETRIES) {
        throw error;
      }

      console.warn(
        `[Corrdex] S3 pack upload retry label=${label} uploadId=${target.uploadId} attempt=${attempt} error=${error instanceof Error ? error.message : String(error)}`,
      );
      await delay(500 * attempt);
    }
  }
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEmptyAst(): ASTMetadata {
  return {
    imports: [],
    importSources: [],
    importedSymbols: [],
    callExpressions: [],
    propertyAccessExpressions: [],
    memberExpressions: [],
    catchClauses: [],
    exports: [],
    classDeclarations: [],
    executionBlocks: [],
    decorators: [],
    ifStatementCount: 0,
    loopCount: 0,
    hasAsyncAwait: false,
  };
}

function applyContentHashToAst(ast: ASTMetadata, content: string): ASTMetadata {
  return {
    ...ast,
    contentHash: `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`,
  };
}

async function completeCoreSyncPackUpload(
  serverBaseUrl: string,
  projectId: string,
  apiKey: string,
  uploadId: string,
  payload: ProjectSyncBootstrapPayload & {
    coreServerBaseUrl: string;
    filesUploaded?: number;
  },
): Promise<Response> {
  return fetch(`${normalizeServerBaseUrl(serverBaseUrl)}/v1/projects/${encodeURIComponent(projectId)}/core-sync-pack/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
}

async function sendChunk(
  coreServerBaseUrl: string,
  uploadId: string,
  chunkIndex: number,
  files: any[],
  localCoreUpload: boolean,
): Promise<Response> {
  const url = `${coreServerBaseUrl}/v1/analyze/ast/upload/${uploadId}/chunk`;
  const body = JSON.stringify({ chunkIndex, files });

  if (localCoreUpload) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

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
      headers: { "content-type": "application/json" },
      body,
    });
  }
  return response;
}

async function sendBlobChunk(
  coreServerBaseUrl: string,
  snapshotId: string,
  blobs: ProjectBlobUploadItem[],
  localCoreUpload: boolean,
): Promise<Response> {
  const url = `${coreServerBaseUrl}/v1/sync/blobs/${snapshotId}/chunk`;
  const body = JSON.stringify({ blobs } satisfies ProjectBlobChunkUploadRequest);

  if (localCoreUpload) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

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
      headers: { "content-type": "application/json" },
      body,
    });
  }

  return response;
}

function isAstSyncCompressionRetryStatus(status: number): boolean {
  return status === 400 || status === 415;
}

function fingerprintAst(ast: ASTMetadata): string {
  if (typeof ast.contentHash === "string" && ast.contentHash.length > 0) {
    return ast.contentHash;
  }
  return crypto.createHash("sha256").update(JSON.stringify(ast)).digest("hex");
}

function fingerprintAnalysisFile(file: CoreAstAnalysisFilePayload): string {
  if (typeof file.contentHash === "string" && file.contentHash.length > 0) {
    return file.contentHash;
  }

  if (typeof file.content === "string") {
    return `sha256:${crypto.createHash("sha256").update(file.content).digest("hex")}`;
  }

  if (file.ast) {
    return fingerprintAst(file.ast);
  }

  return crypto.createHash("sha256").update(file.path).digest("hex");
}

function buildSourceFileSnapshot(files: string[]): SourceFileSnapshot {
  const payloadFiles: CoreAstAnalysisFilePayload[] = [];
  const manifestFiles: ProjectSyncManifestFile[] = [];
  const contentByHash = new Map<string, string>();

  for (const filePath of files) {
    const absoluteFilePath = path.resolve(filePath);
    const stats = fs.statSync(absoluteFilePath);
    const content = fs.readFileSync(absoluteFilePath, "utf-8");
    const contentHash = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;

    payloadFiles.push({
      path: absoluteFilePath,
      content,
      contentHash,
    });
    manifestFiles.push({
      path: absoluteFilePath,
      contentHash,
      size: Buffer.byteLength(content, "utf8"),
      mtimeMs: stats.mtimeMs,
    });

    if (!contentByHash.has(contentHash)) {
      contentByHash.set(contentHash, content);
    }
  }

  payloadFiles.sort((left, right) => left.path.localeCompare(right.path));
  manifestFiles.sort((left, right) => left.path.localeCompare(right.path));

  return {
    files: payloadFiles,
    manifestFiles,
    contentByHash,
  };
}

function isLocalCoreUrl(coreServerBaseUrl: string): boolean {
  try {
    const url = new URL(coreServerBaseUrl);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
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
