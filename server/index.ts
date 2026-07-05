import {
    createConnection,
    TextDocuments,
    DiagnosticSeverity,
    MarkupKind,
    ProposedFeatures,
    TextDocumentSyncKind
} from 'vscode-languageserver/node.js';

import type {
    Diagnostic as LspDiagnostic,
    Hover,
    HoverParams,
    InitializeParams,
    InitializeResult
} from 'vscode-languageserver/node.js';

import { fileURLToPath } from 'url';
import path from 'path';

import { buildHoverMarkdown } from './hoverSummary.js';
import { findHoveredFileSymbol } from './hoverTargeting.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    GET_FILE_CONTEXT_REQUEST,
    GET_SIDEBAR_SNAPSHOT_REQUEST,
    SYNC_TO_SERVER_REQUEST,
    type FileContextRequest,
    type SidebarSnapshotRequest,
    type SyncToServerRequest
} from '../extensionProtocol.js';
import { ProjectRuntimeStore, type DocumentInsight } from './runtime/projectRuntime.js';
import { ValidationScheduler } from './runtime/validationScheduler.js';

// Create a connection for the server, using Node's IPC as a transport.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. 
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
let workspaceRoots: string[] = [];
const runtimeStore = new ProjectRuntimeStore();
const validationScheduler = new ValidationScheduler(700, (uri) => {
    const document = documents.get(uri);
    if (!document) {
        return;
    }
    void validateTextDocument(document);
    runtimeStore.requestWorkspaceRebuild(100);
});

connection.onInitialize((params: InitializeParams) => {
    workspaceRoots = getWorkspaceRoots(params);
    runtimeStore.setWorkspaceRoots(workspaceRoots);
    runtimeStore.setCoreServerBaseUrl(typeof params.initializationOptions?.coreServerBaseUrl === "string" ? params.initializationOptions.coreServerBaseUrl : "");
    runtimeStore.onDiagnosticsUpdated = () => {
        revalidateAllOpenDocuments();
    };
    runtimeStore.requestWorkspaceRebuild(0);

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
        }
    };
    return result;
});

documents.onDidChangeContent(change => {
    validationScheduler.schedule(change.document.uri);
});

documents.onDidOpen((event) => {
    void validateTextDocument(event.document);
});

documents.onDidSave((event) => {
    void validateTextDocument(event.document);
});

documents.onDidClose((event) => {
    validationScheduler.clear(event.document.uri);
    runtimeStore.clear(event.document.uri);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onDidChangeWatchedFiles(() => {
    validationScheduler.clearAll();
    runtimeStore.clearAll();
    runtimeStore.requestWorkspaceRebuild(300);
    revalidateAllOpenDocuments();
});

connection.onRequest(GET_SIDEBAR_SNAPSHOT_REQUEST, (params: SidebarSnapshotRequest) => {
    const document = documents.get(params.uri);
    if (!document) {
        return null;
    }

    return runtimeStore.getSidebarSnapshot(document);
});

connection.onRequest(GET_FILE_CONTEXT_REQUEST, (params: FileContextRequest) => {
    const document = documents.get(params.uri);
    if (!document) {
        return null;
    }

    return runtimeStore.getFileContextSnapshot(document);
});

connection.onRequest(SYNC_TO_SERVER_REQUEST, async (params: SyncToServerRequest) => {
    return await runtimeStore.persistWorkspaceIndex(params.projectId, params.serverBaseUrl, params.apiKey);
});

connection.onHover((params: HoverParams): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    const insight = runtimeStore.getOrUpdateDocument(document);


    if (insight.ast && insight.classification && findHoveredFileSymbol(document, params.position, insight.ast)) {
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: buildHoverMarkdown(insight.filePath, insight.classification),
            },
        };
    }

    return null;
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const insight = runtimeStore.updateDocument(textDocument);
    const corrdexDiagnostics = insight.diagnostics;

    // Map Corrdex diagnostics to LSP diagnostics
    const diagnostics: LspDiagnostic[] = corrdexDiagnostics.map(diag => {
        let severity: DiagnosticSeverity = DiagnosticSeverity.Warning;
        if (diag.severity === 'error') severity = DiagnosticSeverity.Error;
        if (diag.severity === 'warning') severity = DiagnosticSeverity.Warning;
        if (diag.severity === 'info') severity = DiagnosticSeverity.Information;
        const line = Math.max(0, diag.line - 1);
        const col = Math.max(0, diag.column - 1);

        return {
            severity,
            range: {
                start: { line, character: col },
                // Highlight roughly the word/expression since we don't have end lengths yet
                end: { line, character: col + 5 }
            },
            message: diag.message,
            source: 'corrdex',
            code: diag.ruleId
        };
    });

    // Send the computed diagnostics to VSCode.
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

function revalidateAllOpenDocuments(): void {
    for (const document of documents.all()) {
        void validateTextDocument(document);
    }
}



// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();

function getWorkspaceRoots(params: InitializeParams): string[] {
    if (params.workspaceFolders && params.workspaceFolders.length > 0) {
        return params.workspaceFolders.flatMap((folder) => {
            try {
                return [fileURLToPath(folder.uri)];
            } catch {
                return [];
            }
        });
    }

    if (params.rootUri) {
        try {
            return [fileURLToPath(params.rootUri)];
        } catch {
            return [];
        }
    }

    if (params.rootPath) {
        return [params.rootPath];
    }

    return [process.cwd()];
}




