import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node.js";

import { CorrdexAISurface } from "./aiSurface.js";

export class CorrdexAIPanel {
  private static current: CorrdexAIPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly surface: CorrdexAISurface;

  static render(
    context: ExtensionContext,
    client: LanguageClient,
  ): CorrdexAIPanel {
    if (CorrdexAIPanel.current) {
      CorrdexAIPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      void CorrdexAIPanel.current.refresh();
      return CorrdexAIPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "corrdexAI",
      "Corrdex AI",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    CorrdexAIPanel.current = new CorrdexAIPanel(panel, context, client);
    return CorrdexAIPanel.current;
  }

  static refreshCurrent(): Promise<void> {
    return CorrdexAIPanel.current?.refresh() ?? Promise.resolve();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: ExtensionContext,
    client: LanguageClient,
  ) {
    this.panel = panel;
    this.surface = new CorrdexAISurface(this.panel.webview, client, context);

    this.panel.onDidDispose(() => {
      this.surface.dispose();
      if (CorrdexAIPanel.current === this) {
        CorrdexAIPanel.current = undefined;
      }
    }, null, context.subscriptions);

    void this.refresh();
  }

  refresh(): Promise<void> {
    return this.surface.refresh();
  }
}
