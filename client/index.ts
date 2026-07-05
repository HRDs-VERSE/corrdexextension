import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { workspace } from 'vscode';

import {
    LanguageClient,
    TransportKind
} from 'vscode-languageclient/node.js';
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node.js';
import { CorrdexSidebarProvider } from './sidebar.js';
import { CorrdexAIPanel } from './aiPanel.js';
import { CorrdexAIViewProvider } from './aiView.js';
import { clearAIApiKey, setAIApiKey, readScopedAIApiKey } from './aiSurface.js';
import { SYNC_TO_SERVER_REQUEST, type SyncToServerRequest, type SyncToServerResponse } from '../extensionProtocol.js';

let client: LanguageClient;
const SECONDARY_SIDEBAR_HINT_DISMISSED_KEY = 'corrdex.secondarySidebarHintDismissed';

/** Returns a debounced version of fn that delays invocation by ms milliseconds. */
function debounce(fn: () => void, ms: number): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
}

export function activate(context: ExtensionContext) {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(
        path.join('dist', 'server', 'index.cjs')
    );

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6009'] }
        }
    };

    const configWatchers = [
        workspace.createFileSystemWatcher('**/corrdex.config.json'),
        workspace.createFileSystemWatcher('**/corrdex.policies.json'),
        workspace.createFileSystemWatcher('**/mergelens.config.json'),
    ];
    const sourceWatchers = [
        workspace.createFileSystemWatcher('**/*.ts'),
        workspace.createFileSystemWatcher('**/*.tsx'),
        workspace.createFileSystemWatcher('**/*.js'),
        workspace.createFileSystemWatcher('**/*.jsx'),
        workspace.createFileSystemWatcher('**/*.py'),
        workspace.createFileSystemWatcher('**/*.sql'),
    ];

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for supported source files
        documentSelector: [
            { scheme: 'file', language: 'typescript' },
            { scheme: 'file', language: 'javascript' },
            { scheme: 'file', language: 'typescriptreact' },
            { scheme: 'file', language: 'javascriptreact' },
            { scheme: 'file', language: 'python' }
        ],
        initializationOptions: {
            coreServerBaseUrl: workspace.getConfiguration("corrdex.core").get<string>("serverBaseUrl", "")
        },
        synchronize: {
            // Notify the server when Corrdex config or policy files change.
            fileEvents: [...configWatchers, ...sourceWatchers]
        }
    };

    // Create the language client and start the client.
    client = new LanguageClient(
        'corrdexLSP',
        'Corrdex Language Server',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    client.start();

    const sidebarProvider = new CorrdexSidebarProvider(context, client);
    const aiViewProvider = new CorrdexAIViewProvider(context, client);
    const treeView = vscode.window.createTreeView('corrdexSidebar', {
        treeDataProvider: sidebarProvider,
        showCollapseAll: true,
    });

    context.subscriptions.push(
        sidebarProvider,
        vscode.window.registerWebviewViewProvider('corrdexAIView', aiViewProvider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
        treeView,
        vscode.commands.registerCommand('corrdex.refreshSidebar', () => sidebarProvider.refresh()),
        vscode.commands.registerCommand('corrdex.openAI', () => {
            CorrdexAIPanel.render(context, client);
        }),
        vscode.commands.registerCommand('corrdex.focusAI', () => aiViewProvider.reveal()),
        vscode.commands.registerCommand('corrdex.openAISettings', async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Corrdex.corrdex corrdex.ai');
        }),
        vscode.commands.registerCommand('corrdex.setAIApiKey', async () => {
            await setAIApiKey(context);
            void CorrdexAIPanel.refreshCurrent();
            void aiViewProvider.refresh();
        }),
        vscode.commands.registerCommand('corrdex.clearAIApiKey', async () => {
            await clearAIApiKey(context);
            void CorrdexAIPanel.refreshCurrent();
            void aiViewProvider.refresh();
        }),
        vscode.commands.registerCommand('corrdex.syncToServer', async (silent = false) => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }

            let projectId = '';
            try {
                const configUri = vscode.Uri.joinPath(folder.uri, 'corrdex.config.json');
                const configData = await vscode.workspace.fs.readFile(configUri);
                const config = JSON.parse(Buffer.from(configData).toString('utf8'));
                if (config.projectId) {
                    projectId = config.projectId;
                } else if (config.project) {
                    // Fallback for older configs
                    projectId = config.project;
                }
            } catch (e) {
                // Ignore missing config
            }

            if (!projectId) {
                if (silent) return;
                const inputId = await vscode.window.showInputBox({ prompt: 'Enter Corrdex Project ID for sync:' });
                if (!inputId) return;
                projectId = inputId;
                
                // Save it to corrdex.config.json
                const configUri = vscode.Uri.joinPath(folder.uri, 'corrdex.config.json');
                let newConfig: any = { project: projectId };
                try {
                    const existingData = await vscode.workspace.fs.readFile(configUri);
                    const existingJson = JSON.parse(Buffer.from(existingData).toString('utf8'));
                    newConfig = { ...existingJson, projectId: projectId };
                } catch (e) {
                    // Ignore, file doesn't exist or is invalid
                }
                await vscode.workspace.fs.writeFile(configUri, Buffer.from(JSON.stringify(newConfig, null, 2)));
                void vscode.window.showInformationMessage(`Saved Corrdex Project ID '${projectId}' to corrdex.config.json`);
            }

            let apiKey = await readScopedAIApiKey(context, projectId, folder.uri);
            if (!apiKey) {
                if (silent) return;
                await setAIApiKey(context, projectId);
                apiKey = await readScopedAIApiKey(context, projectId, folder.uri);
                if (!apiKey) {
                    vscode.window.showErrorMessage('API Key is required to sync to server.');
                    return;
                }
            }

            const serverBaseUrl = vscode.workspace.getConfiguration('corrdex').get<string>('serverBaseUrl') || 'http://localhost:3000';

            try {
                const req: SyncToServerRequest = { projectId, serverBaseUrl, apiKey };
                if (silent) {
                    const res = await client.sendRequest<SyncToServerResponse>(SYNC_TO_SERVER_REQUEST, req);
                    if (!res.ok) {
                        console.warn(`[Corrdex] Auto-sync failed: ${res.message}`);
                    }
                } else {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Corrdex: Syncing to Server...',
                        cancellable: false
                    }, async () => {
                        const res = await client.sendRequest<SyncToServerResponse>(SYNC_TO_SERVER_REQUEST, req);
                        if (res.ok) {
                            vscode.window.showInformationMessage(`Corrdex Sync Success: ${res.message} (Files: ${res.filesUploaded || 0})`);
                        } else if (res.indexRun?.ok || res.scanRun?.ok) {
                            vscode.window.showWarningMessage(`Corrdex Partial Sync: ${res.message} (Files: ${res.filesUploaded || 0})`);
                        } else {
                            vscode.window.showErrorMessage(`Corrdex Sync Failed: ${res.message}`);
                        }
                    });
                }
            } catch (e: any) {
                if (!silent) vscode.window.showErrorMessage(`Corrdex Sync Error: ${e.message}`);
                else console.warn(`[Corrdex] Auto-sync error: ${e.message}`);
            }
        }),
        vscode.commands.registerCommand('corrdex.openConfig', async () => {
            const editor = vscode.window.activeTextEditor;
            const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                return;
            }

            const configCandidates = [
                vscode.Uri.joinPath(folder.uri, 'corrdex.config.json'),
                vscode.Uri.joinPath(folder.uri, 'corrdex.policies.json'),
            ];

            for (const candidate of configCandidates) {
                try {
                    await vscode.workspace.fs.stat(candidate);
                    await vscode.window.showTextDocument(candidate);
                    return;
                } catch {
                    // Try next candidate.
                }
            }

            const created = configCandidates[0];
            await vscode.workspace.fs.writeFile(created, Buffer.from('{\n  "rules": {}\n}\n', 'utf8'));
            await vscode.window.showTextDocument(created);
        }),
        vscode.commands.registerCommand('corrdex.openDiagnostic', async (filePath: string, line: number, column: number) => {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const editor = await vscode.window.showTextDocument(document);
            const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }),
        vscode.window.onDidChangeActiveTextEditor(() => sidebarProvider.refresh()),
        vscode.window.onDidChangeActiveTextEditor(
            // Debounced so rapid file switching doesn't flood the LSP with
            // requests or trigger repeated postMessage patches on the webview.
            debounce(() => {
                void CorrdexAIPanel.refreshCurrent();
                void aiViewProvider.refresh();
            }, 300)
        ),
        vscode.workspace.onDidSaveTextDocument(() => sidebarProvider.refresh()),
        vscode.workspace.onDidSaveTextDocument(() => {
            void CorrdexAIPanel.refreshCurrent();
            void aiViewProvider.refresh();
            
            const autoSync = vscode.workspace.getConfiguration('corrdex').get<boolean>('autoSyncOnSave');
            if (autoSync) {
                void vscode.commands.executeCommand('corrdex.syncToServer', true);
            }
        }),
    );

    context.subscriptions.push(...configWatchers, ...sourceWatchers);

    void maybeOpenAIDefaultSurface(aiViewProvider);
    void maybeShowSecondarySidebarHint(context, aiViewProvider);
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

async function maybeOpenAIDefaultSurface(aiViewProvider: CorrdexAIViewProvider): Promise<void> {
    const openOnStartup = vscode.workspace.getConfiguration('corrdex.ai').get<boolean>('openOnStartup', true);
    if (!openOnStartup) {
        return;
    }

    await delay(900);
    await aiViewProvider.reveal();
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeShowSecondarySidebarHint(
    context: ExtensionContext,
    aiViewProvider: CorrdexAIViewProvider,
): Promise<void> {
    const dismissed = context.globalState.get<boolean>(SECONDARY_SIDEBAR_HINT_DISMISSED_KEY, false);
    if (dismissed) {
        return;
    }

    await delay(1800);

    const choice = await vscode.window.showInformationMessage(
        "For a Codex-like layout, drag the Corrdex AI view into VS Code's Secondary Sidebar once. Corrdex will keep opening from there after that.",
        "Open Corrdex AI",
        "Don't Show Again",
    );

    if (choice === "Open Corrdex AI") {
        await aiViewProvider.reveal();
        return;
    }

    if (choice === "Don't Show Again") {
        await context.globalState.update(SECONDARY_SIDEBAR_HINT_DISMISSED_KEY, true);
    }
}


