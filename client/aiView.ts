import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node.js";

import { CorrdexAISurface } from "./aiSurface.js";

export class CorrdexAIViewProvider implements vscode.WebviewViewProvider {
  private currentView: vscode.WebviewView | undefined;
  private currentSurface: CorrdexAISurface | undefined;

  constructor(
    private readonly context: ExtensionContext,
    private readonly client: LanguageClient,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.currentView = webviewView;
    this.currentSurface?.dispose();
    this.currentSurface = new CorrdexAISurface(webviewView.webview, this.client, this.context);

    webviewView.onDidDispose(() => {
      this.currentSurface?.dispose();
      this.currentView = undefined;
      this.currentSurface = undefined;
    }, null, this.context.subscriptions);

    void this.currentSurface.refresh();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.corrdexAI");
    this.currentView?.show?.(true);
    await this.refresh();
  }

  refresh(): Promise<void> {
    return this.currentSurface?.refresh() ?? Promise.resolve();
  }
}
