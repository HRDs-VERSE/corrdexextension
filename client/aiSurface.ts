import * as path from "node:path";
import * as vscode from "vscode";
import { marked } from "marked";
import type { Disposable, ExtensionContext, Webview } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node.js";

import {
  GET_FILE_CONTEXT_REQUEST,
  type FileContextSnapshot,
} from "../extensionProtocol.js";

const AI_API_KEY_SECRET_KEY = "corrdex.ai.apiKey";

type AskScope = "current-file" | "project-overview";
type AnswerFormat = "plain" | "markdown";

type AskResult = {
  title: string;
  body: string[];
  suggestions: string[];
  format?: AnswerFormat;
  sourceLabel?: string;
  remoteSessionId?: string;
  remoteSessionTitle?: string;
  remoteProjectId?: string;
};

type HistoryEntry = {
  question: string;
  title: string;
  body: string[];
  format?: AnswerFormat;
  sourceLabel?: string;
  pending?: boolean;
};

type ChatThread = {
  id: string;
  title: string;
  updatedAt: number;
  history: HistoryEntry[];
  remoteSessionId?: string;
  remoteProjectId?: string;
};

type PanelState = {
  suggestedPrompts: string[];
  history: HistoryEntry[];
  chats: ChatThread[];
  currentChatId: string | null;
  selectedScope: AskScope;
  remoteConfigured: boolean;
  remoteStatusLabel: string;
};

type RemoteChatEnvelope = {
  answer?: {
    markdown?: string;
    provider?: string;
    model?: string;
  };
  chat?: {
    session?: {
      id?: string;
      title?: string;
      status?: string;
    };
  };
  error?: {
    code?: string;
    message?: string;
  };
};

type RemoteChatStreamStartEnvelope = {
  chat?: {
    session?: {
      id?: string;
      title?: string;
      status?: string;
    };
  };
};

type RemoteChatStreamDoneEnvelope = {
  answer?: {
    markdown?: string;
    provider?: string;
    model?: string;
    finishReason?: string;
  };
  chat?: {
    session?: {
      id?: string;
      title?: string;
      status?: string;
    };
  };
};

type RemoteChatTurn = {
  role: "user" | "assistant";
  content: string;
};

type RemoteChatRequest = {
  projectId: string;
  question: string;
  includeContext: boolean;
  currentView: "project";
  conversation?: RemoteChatTurn[];
  sessionId?: string;
};

type ActiveRemoteChatState = {
  sessionId?: string;
  conversation: RemoteChatTurn[];
};

type RemoteConfig =
  | {
      ok: true;
      baseUrl: string;
      projectId: string;
      includeContext: boolean;
      apiKey: string;
    }
  | {
      ok: false;
      message: string;
    };

export class CorrdexAISurface implements Disposable {
  private currentQuestion = "";
  private currentScope: AskScope = "current-file";
  private chats: ChatThread[] = [];
  private currentChatId: string | null = null;
  private disposed = false;
  private htmlRendered = false;
  private isWebviewReady = false;
  private activeAbortController: AbortController | null = null;

  private get history(): HistoryEntry[] {
    const chat = this.chats.find(c => c.id === this.currentChatId);
    return chat ? chat.history : [];
  }

  private get activeChat(): ChatThread | null {
    return this.chats.find((chat) => chat.id === this.currentChatId) ?? null;
  }

  private saveChats() {
    void this.context.workspaceState.update("corrdex.ai.chats", this.chats);
  }

  private loadChats() {
    this.chats = this.context.workspaceState.get<ChatThread[]>("corrdex.ai.chats") || [];
    if (this.chats.length > 0 && !this.currentChatId) {
      this.currentChatId = this.chats[0].id;
    }
  }

  constructor(
    private readonly webview: Webview,
    private readonly client: LanguageClient,
    private readonly context: ExtensionContext,
  ) {
    this.webview.options = {
      enableScripts: true,
    };
    this.loadChats();

    this.webview.onDidReceiveMessage(async (message: { type?: string; query?: string; scope?: AskScope; chatId?: string }) => {
      if (message.type === "ready") {
        this.isWebviewReady = true;
        await this.refresh();
        return;
      }

      if (message.type === "refresh") {
        await this.refresh();
        return;
      }

      if (message.type === "setScope") {
        this.currentScope = normalizeScope(message.scope);
        await this.refresh({ passive: true });
        return;
      }

      if (message.type === "ask") {
        this.currentScope = normalizeScope(message.scope);
        this.currentQuestion = (message.query ?? "").trim();
        await this.ask();
        return;
      }

      if (message.type === "openSettings") {
        await vscode.commands.executeCommand("corrdex.openAISettings");
        return;
      }

      if (message.type === "setApiKey") {
        await vscode.commands.executeCommand("corrdex.setAIApiKey");
        await this.refresh({ passive: true });
        return;
      }

      if (message.type === "pushIndex") {
        await vscode.commands.executeCommand("corrdex.syncToServer", false);
        return;
      }

      if (message.type === "newChat") {
        this.currentChatId = null;
        this.currentQuestion = "";
        await this.refresh();
        return;
      }

      if (message.type === "loadChat" && message.chatId) {
        this.currentChatId = message.chatId;
        this.currentQuestion = "";
        await this.refresh();
        return;
      }

      if (message.type === "clearHistory") {
        this.chats = [];
        this.currentChatId = null;
        this.currentQuestion = "";
        this.saveChats();
        await this.refresh();
        return;
      }
      
      if (message.type === "abort") {
        if (this.activeAbortController) {
          this.activeAbortController.abort();
          this.activeAbortController = null;
        }
        return;
      }

      if (message.type === "copy" && message.query) {
        await vscode.env.clipboard.writeText(message.query);
        void vscode.window.showInformationMessage("Message copied to clipboard.");
        return;
      }

      if (message.type === "editLast") {
        const chat = this.chats.find(c => c.id === this.currentChatId);
        if (chat && chat.history.length > 0) {
          const lastInteraction = chat.history.pop();
          this.saveChats();
          await this.refresh();
          if (lastInteraction) {
            this.webview.postMessage({ type: 'populateInput', text: lastInteraction.question });
          }
        }
        return;
      }
    }, null, this.context.subscriptions);
  }

  dispose(): void {
    this.disposed = true;
  }

  async refresh(options?: { passive?: boolean }): Promise<void> {
    if (this.disposed) return;

    const passive = options?.passive ?? false;
    const snapshot = await this.getActiveFileContext();
    const remoteConfig = await this.readRemoteConfig();
    const askResult = await this.resolveAnswer(snapshot, remoteConfig, passive);
    this.renderState(remoteConfig, askResult.suggestions);
  }

  private async ask(): Promise<void> {
    if (this.disposed || !this.currentQuestion) {
      return;
    }

    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    this.activeAbortController = new AbortController();

    const snapshot = await this.getActiveFileContext();
    const remoteConfig = await this.readRemoteConfig();
    this.pushPendingHistoryEntry(this.currentQuestion);
    this.renderState(remoteConfig, buildSuggestionsForScope(this.currentScope, snapshot));

    try {
      const askResult = await this.resolveAnswer(snapshot, remoteConfig, false);
      this.replaceLatestHistoryEntry(this.currentQuestion, askResult);
      this.renderState(remoteConfig, askResult.suggestions);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        const result: AskResult = {
          title: "Aborted",
          body: ["Generation stopped."],
          suggestions: buildProjectPromptSuggestions(),
          sourceLabel: "Aborted",
        };
        this.replaceLatestHistoryEntry(this.currentQuestion, result);
        this.renderState(remoteConfig, result.suggestions);
      } else {
        throw e;
      }
    } finally {
      this.activeAbortController = null;
    }
  }

  private ensureActiveChat() {
    if (!this.currentChatId) {
      this.currentChatId = `chat-${Date.now()}`;
      this.chats.unshift({
        id: this.currentChatId,
        title: "New Chat",
        updatedAt: Date.now(),
        history: [],
      });
      this.saveChats();
    }
  }

  private updateActiveChatTitle() {
    const chat = this.chats.find(c => c.id === this.currentChatId);
    if (chat && chat.history.length > 0) {
      chat.title = chat.history[0].question.replace(/\s+/g, " ").trim().slice(0, 60);
      chat.updatedAt = Date.now();
      this.saveChats();
    }
  }

  private async getActiveFileContext(): Promise<FileContextSnapshot | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedDocument(editor.document)) {
      return null;
    }

    try {
      return await this.client.sendRequest<FileContextSnapshot | null>(
        GET_FILE_CONTEXT_REQUEST,
        { uri: editor.document.uri.toString() },
      );
    } catch {
      return null;
    }
  }

  private async resolveAnswer(
    snapshot: FileContextSnapshot | null,
    remoteConfig: RemoteConfig,
    passive: boolean,
  ): Promise<AskResult> {
    if (isCapabilityQuestion(this.currentQuestion)) {
      return buildCapabilityAnswer(this.currentScope, snapshot, remoteConfig);
    }

    if (this.currentScope === "project-overview") {
      if (!this.currentQuestion) {
        return {
          title: "",
          body: [],
          suggestions: buildProjectPromptSuggestions(),
          sourceLabel: remoteConfig.ok ? "Remote Corrdex AI" : "Remote Corrdex AI unavailable",
        };
      }

      if (passive) {
        const latest = this.history.find((entry) => entry.question === this.currentQuestion);
        if (latest) {
          return {
            title: latest.title,
            body: latest.body,
            suggestions: buildProjectPromptSuggestions(),
            sourceLabel: latest.sourceLabel ?? "Remote Corrdex AI",
            format: "markdown",
          };
        }
      }

      if (!remoteConfig.ok) {
        return {
          title: "Not configured",
          body: [remoteConfig.message],
          suggestions: buildProjectPromptSuggestions(),
          sourceLabel: "Remote Corrdex AI unavailable",
        };
      }

      return this.fetchRemoteProjectAnswerStream(remoteConfig, this.currentQuestion, snapshot);
    }

    if (!snapshot) {
      return {
        title: "",
        body: [],
        suggestions: buildFilePromptSuggestions(undefined),
        sourceLabel: "Local current file",
      };
    }

    const local = answerLocalCurrentFile(this.currentQuestion, snapshot);
    return {
      ...local,
      sourceLabel: buildLocalSourceLabel(snapshot),
    };
  }

  private async fetchRemoteProjectAnswer(
    remoteConfig: Extract<RemoteConfig, { ok: true }>,
    question: string,
    snapshot: FileContextSnapshot | null,
  ): Promise<AskResult> {
    const activeRemoteChat = this.getActiveRemoteChatState(remoteConfig.projectId);

    try {
      const response = await fetch(`${remoteConfig.baseUrl}/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${remoteConfig.apiKey}`,
        },
        body: JSON.stringify(this.buildRemoteChatRequest(remoteConfig, question, activeRemoteChat)),
      });

      const body = await response.json() as RemoteChatEnvelope;
      if (!response.ok) {
        const message = body.error?.message?.trim() || `Remote AI returned ${response.status}.`;
        return {
          title: "Error",
          body: [message],
          suggestions: buildProjectPromptSuggestions(),
          sourceLabel: "Remote Corrdex AI error",
        };
      }

      const markdown = body.answer?.markdown?.trim();
      if (!markdown) {
        return {
          title: "Error",
          body: ["The backend returned an empty AI answer."],
          suggestions: buildProjectPromptSuggestions(),
          sourceLabel: "Remote Corrdex AI error",
        };
      }

      const provider = body.answer?.provider?.trim();
      const model = body.answer?.model?.trim();
      const sourceBits = [provider, model].filter(Boolean);
      const localWorkspaceWarning = buildLocalWorkspaceWarning(snapshot, question);

      return {
        title: "Corrdex AI",
        body: localWorkspaceWarning ? [localWorkspaceWarning, markdown] : [markdown],
        suggestions: buildProjectPromptSuggestions(),
        format: "markdown",
        remoteSessionId: body.chat?.session?.id?.trim(),
        remoteSessionTitle: body.chat?.session?.title?.trim(),
        remoteProjectId: remoteConfig.projectId,
        sourceLabel: sourceBits.length > 0
          ? `${sourceBits.join(" · ")} · shared remote state`
          : "Remote Corrdex AI · shared remote state",
      };
    } catch (error) {
      return {
        title: "Error",
        body: [
          error instanceof Error && error.message
            ? error.message
            : "Unable to reach the configured Corrdex AI backend.",
        ],
        suggestions: buildProjectPromptSuggestions(),
        sourceLabel: "Remote Corrdex AI error",
      };
    }
  }

  private async fetchRemoteProjectAnswerStream(
    remoteConfig: Extract<RemoteConfig, { ok: true }>,
    question: string,
    snapshot: FileContextSnapshot | null,
  ): Promise<AskResult> {
    const localWorkspaceWarning = buildLocalWorkspaceWarning(snapshot, question);
    let streamedMarkdown = "";
    const activeRemoteChat = this.getActiveRemoteChatState(remoteConfig.projectId);

    try {
      const response = await fetch(`${remoteConfig.baseUrl}/ai/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${remoteConfig.apiKey}`,
        },
        body: JSON.stringify(this.buildRemoteChatRequest(remoteConfig, question, activeRemoteChat)),
        signal: this.activeAbortController?.signal,
      });

      if (!response.ok) {
        const body = await response.json() as RemoteChatEnvelope;
        const message = body.error?.message?.trim() || `Remote AI returned ${response.status}.`;
        return {
          title: "Error",
          body: [message],
          suggestions: buildProjectPromptSuggestions(),
          sourceLabel: "Remote Corrdex AI error",
        };
      }

      if (!response.body) {
        return {
          title: "Error",
          body: ["The backend did not return a readable AI stream."],
          suggestions: buildProjectPromptSuggestions(),
          sourceLabel: "Remote Corrdex AI error",
        };
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";
      let donePayload: RemoteChatStreamDoneEnvelope | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSSEEvent(rawEvent);
          if (parsed) {
            const handled = this.handleRemoteProjectStreamEvent(
              parsed.event,
              parsed.data,
              question,
              remoteConfig,
              localWorkspaceWarning,
              streamedMarkdown,
            );
            streamedMarkdown = handled.markdown;
            if (handled.donePayload) {
              donePayload = handled.donePayload;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }

      const finalMarkdown = streamedMarkdown.trim();
      if (!finalMarkdown) {
        return {
          title: "Error",
          body: ["The backend returned an empty AI answer."],
          suggestions: buildProjectPromptSuggestions(),
          sourceLabel: "Remote Corrdex AI error",
        };
      }

      return {
        title: "Corrdex AI",
        body: localWorkspaceWarning ? [localWorkspaceWarning, finalMarkdown] : [finalMarkdown],
        suggestions: buildProjectPromptSuggestions(),
        format: "markdown",
        remoteSessionId: donePayload?.chat?.session?.id?.trim(),
        remoteSessionTitle: donePayload?.chat?.session?.title?.trim(),
        remoteProjectId: remoteConfig.projectId,
        sourceLabel: buildRemoteSourceLabel(donePayload?.answer?.provider, donePayload?.answer?.model),
      };
    } catch (error) {
      return {
        title: "Error",
        body: [
          error instanceof Error && error.message
            ? error.message
            : "Unable to reach the configured Corrdex AI backend.",
        ],
        suggestions: buildProjectPromptSuggestions(),
        sourceLabel: "Remote Corrdex AI error",
      };
    }
  }

  private async readRemoteConfig(): Promise<RemoteConfig> {
    const scopeUri = this.getActiveWorkspaceScopeUri();
    const config = scopeUri
      ? vscode.workspace.getConfiguration("corrdex.ai", scopeUri)
      : vscode.workspace.getConfiguration("corrdex.ai");
    const baseUrl = normalizeBaseUrl(config.get<string>("serverBaseUrl", ""));
    const configProjectId = await this.readProjectIdFromCorrdexConfig(scopeUri);
    const projectId = configProjectId;
    const includeContext = config.get<boolean>("includeContext", false);
    const apiKey = await readScopedAIApiKey(this.context, projectId, scopeUri);

    if (!baseUrl) {
      return { ok: false, message: "Set corrdex.ai.serverBaseUrl to enable remote project answers." };
    }
    if (!projectId) {
      const workspaceLabel = this.getActiveWorkspaceLabel();
      return {
        ok: false,
        message: workspaceLabel
          ? `Set projectId in ${workspaceLabel}/corrdex.config.json`
          : "Set projectId in corrdex.config.json to tell Corrdex AI which project to query.",
      };
    }
    if (!apiKey) {
      return { ok: false, message: "Run 'Corrdex: Set AI API Key' to enable remote project answers." };
    }

    return { ok: true, baseUrl, projectId, includeContext, apiKey };
  }

  private getActiveWorkspaceScopeUri(): vscode.Uri | undefined {
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    if (editorUri) {
      const editorFolder = vscode.workspace.getWorkspaceFolder(editorUri);
      if (editorFolder) {
        return editorFolder.uri;
      }
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private async readProjectIdFromCorrdexConfig(scopeUri: vscode.Uri | undefined): Promise<string> {
    return readProjectIdFromCorrdexConfig(scopeUri);
  }

  private getActiveWorkspaceLabel(): string | undefined {
    const scopeUri = this.getActiveWorkspaceScopeUri();
    if (!scopeUri) {
      return undefined;
    }

    return vscode.workspace.getWorkspaceFolder(scopeUri)?.name ?? path.basename(scopeUri.fsPath);
  }

  private renderState(remoteConfig: RemoteConfig, suggestions: string[]): void {
    const state = buildPanelState(
      {
        title: "",
        body: [],
        suggestions,
      },
      this.history,
      this.currentScope,
      remoteConfig,
      this,
    );

    if (!this.htmlRendered || !this.isWebviewReady) {
      this.webview.html = renderHtml(state);
      this.htmlRendered = true;
      return;
    }

    void this.webview.postMessage({
      type: "stateUpdate",
      sections: buildSections(state),
      scopeValue: state.selectedScope,
    });
  }

  private pushPendingHistoryEntry(question: string): void {
    this.ensureActiveChat();
    const chat = this.chats.find((c) => c.id === this.currentChatId);
    if (!chat) return;
    chat.history.push({
      question,
      title: "Corrdex AI",
      body: ["Thinking..."],
      format: "markdown",
      pending: true,
      sourceLabel: this.currentScope === "project-overview"
        ? "Remote Corrdex AI"
        : "Local current file",
    });
    this.saveChats();
  }

  private replaceLatestHistoryEntry(question: string, askResult: AskResult): void {
    const index = this.findLatestPendingHistoryEntryIndex(question);
    const nextEntry: HistoryEntry = {
      question,
      title: askResult.title,
      body: askResult.body,
      format: askResult.format,
      sourceLabel: askResult.sourceLabel,
      pending: false,
    };

    if (index === -1) {
      this.history.push(nextEntry);
      this.syncRemoteChatSession(askResult);
      this.saveChats();
      return;
    }

    this.history[index] = nextEntry;
    this.syncRemoteChatSession(askResult);
    this.updateActiveChatTitle();
    this.saveChats();
  }

  private updateLatestPendingHistoryEntry(question: string, patch: Partial<HistoryEntry>): void {
    const index = this.findLatestPendingHistoryEntryIndex(question);
    if (index === -1) {
      return;
    }

    this.history[index] = {
      ...this.history[index],
      ...patch,
    };
    this.saveChats();
  }

  private findLatestPendingHistoryEntryIndex(question: string): number {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const entry = this.history[index];
      if (entry?.pending && entry.question === question) {
        return index;
      }
    }

    return -1;
  }

  private handleRemoteProjectStreamEvent(
    eventName: string,
    rawData: string,
    question: string,
    remoteConfig: Extract<RemoteConfig, { ok: true }>,
    localWorkspaceWarning: string | null,
    currentMarkdown: string,
  ): { markdown: string; donePayload?: RemoteChatStreamDoneEnvelope } {
    if (!rawData.trim()) {
      return { markdown: currentMarkdown };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawData);
    } catch {
      return { markdown: currentMarkdown };
    }

    if (eventName === "start") {
      const startPayload = payload as RemoteChatStreamStartEnvelope;
      this.rememberRemoteSession(
        startPayload.chat?.session?.id?.trim(),
        startPayload.chat?.session?.title?.trim(),
        remoteConfig.projectId,
      );
      this.updateLatestPendingHistoryEntry(question, {
        sourceLabel: buildRemoteSourceLabel(),
      });
      this.renderState(remoteConfig, buildProjectPromptSuggestions());
      return { markdown: currentMarkdown };
    }

    if (eventName === "context_ready") {
      this.updateLatestPendingHistoryEntry(question, {
        body: localWorkspaceWarning ? [localWorkspaceWarning, "Thinking..."] : ["Thinking..."],
      });
      this.renderState(remoteConfig, buildProjectPromptSuggestions());
      return { markdown: currentMarkdown };
    }

    if (eventName === "delta") {
      const deltaText = typeof (payload as { text?: unknown }).text === "string"
        ? (payload as { text: string }).text
        : "";
      const nextMarkdown = currentMarkdown + deltaText;
      this.updateLatestPendingHistoryEntry(question, {
        body: localWorkspaceWarning ? [localWorkspaceWarning, nextMarkdown || "Thinking..."] : [nextMarkdown || "Thinking..."],
        format: "markdown",
      });
      this.renderState(remoteConfig, buildProjectPromptSuggestions());
      return { markdown: nextMarkdown };
    }

    if (eventName === "error") {
      const message = typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message
        : "Remote AI stream failed.";
      throw new Error(message);
    }

    if (eventName === "done") {
      const donePayload = payload as RemoteChatStreamDoneEnvelope;
      const finalMarkdown = donePayload.answer?.markdown?.trim() || currentMarkdown || "Completed.";
      this.rememberRemoteSession(
        donePayload.chat?.session?.id?.trim(),
        donePayload.chat?.session?.title?.trim(),
        remoteConfig.projectId,
      );
      this.updateLatestPendingHistoryEntry(question, {
        body: localWorkspaceWarning
          ? [localWorkspaceWarning, finalMarkdown]
          : [finalMarkdown],
        format: "markdown",
        sourceLabel: buildRemoteSourceLabel(donePayload.answer?.provider, donePayload.answer?.model),
      });
      this.renderState(remoteConfig, buildProjectPromptSuggestions());
      return { markdown: finalMarkdown, donePayload };
    }

    return { markdown: currentMarkdown };
  }

  private buildRemoteChatRequest(
    remoteConfig: Extract<RemoteConfig, { ok: true }>,
    question: string,
    activeRemoteChat: ActiveRemoteChatState,
  ): RemoteChatRequest {
    return {
      projectId: remoteConfig.projectId,
      question,
      includeContext: remoteConfig.includeContext,
      currentView: "project",
      ...(activeRemoteChat.sessionId ? { sessionId: activeRemoteChat.sessionId } : {}),
      ...(activeRemoteChat.conversation.length > 0 ? { conversation: activeRemoteChat.conversation } : {}),
    };
  }

  private getActiveRemoteChatState(projectId: string): ActiveRemoteChatState {
    const thread = this.activeChat;
    if (!thread) {
      return {
        conversation: [],
      };
    }

    const conversation = thread.history
      .filter((entry) => !entry.pending)
      .filter((entry) => !isLocalHistoryEntry(entry))
      .flatMap((entry) => {
        const turns: RemoteChatTurn[] = [
          {
            role: "user",
            content: entry.question,
          },
        ];
        const assistantContent = entry.body.join("\n\n").trim();
        if (assistantContent) {
          turns.push({
            role: "assistant",
            content: assistantContent,
          });
        }
        return turns;
      })
      .slice(-12);

    return {
      sessionId: thread.remoteProjectId === projectId ? thread.remoteSessionId : undefined,
      conversation,
    };
  }

  private rememberRemoteSession(
    sessionId: string | undefined,
    sessionTitle: string | undefined,
    projectId: string,
  ): void {
    const thread = this.activeChat;
    if (!thread || !sessionId) {
      return;
    }

    thread.remoteSessionId = sessionId;
    thread.remoteProjectId = projectId;
    if (sessionTitle) {
      thread.title = sessionTitle;
    }
    thread.updatedAt = Date.now();
    this.saveChats();
  }

  private syncRemoteChatSession(askResult: AskResult): void {
    if (this.currentScope !== "project-overview") {
      return;
    }

    if (!askResult.remoteProjectId) {
      return;
    }

    this.rememberRemoteSession(
      askResult.remoteSessionId,
      askResult.remoteSessionTitle,
      askResult.remoteProjectId,
    );
  }
}

export async function setAIApiKey(context: ExtensionContext, providedProjectId?: string): Promise<void> {
  const scopeUri = getActiveWorkspaceScopeUri();
  const config = scopeUri
    ? vscode.workspace.getConfiguration("corrdex.ai", scopeUri)
    : vscode.workspace.getConfiguration("corrdex.ai");
  const configProjectId = await readProjectIdFromCorrdexConfig(scopeUri);
  const projectId = providedProjectId || configProjectId;
  const existing = await readScopedAIApiKey(context, projectId, scopeUri);
  const workspaceLabel = getWorkspaceScopeLabel(scopeUri);
  const value = await vscode.window.showInputBox({
    title: "Corrdex AI API Key",
    prompt: workspaceLabel
      ? `Paste the API key for workspace '${workspaceLabel}'.`
      : "Paste the API key used for Corrdex AI endpoints such as /v1/ai/chat.",
    password: true,
    ignoreFocusOut: true,
    value: existing ?? "",
  });

  if (value === undefined) return;

  const trimmed = value.trim();
  if (!trimmed) {
    await clearScopedAIApiKey(context, projectId, scopeUri);
    void vscode.window.showInformationMessage(
      workspaceLabel ? `Corrdex AI API key cleared for '${workspaceLabel}'.` : "Corrdex AI API key cleared.",
    );
    return;
  }

  await storeScopedAIApiKey(context, trimmed, projectId, scopeUri);
  if (projectId) {
    void vscode.window.showInformationMessage(`Corrdex AI API key saved for project '${projectId}'.`);
  } else {
    void vscode.window.showInformationMessage(
      workspaceLabel ? `Corrdex AI API key saved for workspace '${workspaceLabel}'.` : "Corrdex AI API key saved.",
    );
  }
}

export async function clearAIApiKey(context: ExtensionContext): Promise<void> {
  const scopeUri = getActiveWorkspaceScopeUri();
  const config = scopeUri
    ? vscode.workspace.getConfiguration("corrdex.ai", scopeUri)
    : vscode.workspace.getConfiguration("corrdex.ai");
  const configProjectId = await readProjectIdFromCorrdexConfig(scopeUri);
  const projectId = configProjectId;
  const workspaceLabel = getWorkspaceScopeLabel(scopeUri);
  await clearScopedAIApiKey(context, projectId, scopeUri);
  void vscode.window.showInformationMessage(
    workspaceLabel ? `Corrdex AI API key cleared for '${workspaceLabel}'.` : "Corrdex AI API key cleared.",
  );
}

// ── State builder ─────────────────────────────────────────────────────────────

function buildPanelState(
  askResult: AskResult,
  history: HistoryEntry[],
  selectedScope: AskScope,
  remoteConfig: RemoteConfig,
  surface: CorrdexAISurface,
): PanelState {
  return {
    suggestedPrompts: askResult.suggestions,
    history,
    chats: (surface as any).chats,
    currentChatId: (surface as any).currentChatId,
    selectedScope,
    remoteConfigured: remoteConfig.ok,
    remoteStatusLabel: remoteConfig.ok ? "" : remoteConfig.message,
  };
}

// ── Section renderers ─────────────────────────────────────────────────────────

function buildSections(state: PanelState): Record<string, string> {
  const chatOptions = state.chats.map(c => 
    `<option value="${c.id}"${c.id === state.currentChatId ? ' selected' : ''}>${escapeHtml(c.title || 'New Chat')}</option>`
  ).join("");

  return {
    "crd-messages": renderMessages(state.history),
    "crd-prompts": state.suggestedPrompts
      .map((p) => `<button class="chip" data-prompt="${escapeAttribute(p)}">${escapeHtml(p)}</button>`)
      .join(""),
    "crd-chat-options": chatOptions,
    "crd-scope-label": state.selectedScope === "current-file" ? "Current file" : "Project overview",
    "crd-remote-status": state.remoteStatusLabel
      ? `<span class="status-warn">${escapeHtml(state.remoteStatusLabel)}</span>`
      : "",
  };
}

function renderMessages(history: HistoryEntry[]): string {
  if (history.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="80" height="80">
            <path d="M 18.5 85 L 18.5 39 L 58 10 L 32 39 L 26 77 Z" fill="#ffffff" />
            <path d="M 34 39 L 45 39 L 56 54.33 L 67 39 L 78 39 L 61.5 62 L 78 85 L 67 85 L 56 69.67 L 45 85 L 34 85 L 50.5 62 Z" fill="#ffffff" />
          </svg>
        </div>
        <div class="empty-label">Ask Corrdex AI anything about your codebase</div>
        <div class="empty-hint">Architecture, risks, dependencies, blast radius</div>
      </div>`;
  }

  return history.map((entry, index) => {
    const isLast = index === history.length - 1;
    const isPending = entry.pending;
    return `
    <div class="message-pair">
      <div class="user-bubble-wrapper">
        <div class="user-bubble">${escapeHtml(entry.question)}</div>
        ${isLast ? `<button class="action edit-msg" type="button" title="Update Message">Update</button>` : ""}
      </div>
      <div class="ai-bubble">
        <div class="ai-body ${entry.format === "markdown" ? "markdown" : ""}${isPending ? " pending" : ""}">
          ${renderMessageBody(entry)}
          ${isPending ? `<div class="abort-wrapper"><button class="action abort-msg" type="button">⏹ Stop Generating</button></div>` : ""}
        </div>
        <div class="ai-footer">
          ${entry.sourceLabel ? `<div class="ai-source">${escapeHtml(entry.sourceLabel)}</div>` : `<div></div>`}
          ${!isPending && entry.body.length > 0 ? `<button class="action copy-msg" type="button" title="Copy Message" data-raw="${escapeAttribute(entry.body.join('\n\n'))}">Copy</button>` : ""}
        </div>
      </div>
    </div>
  `;
  }).join("");
}

function renderMessageBody(entry: HistoryEntry): string {
  if (entry.pending && entry.body.length > 0 && entry.body[entry.body.length - 1] === "Thinking...") {
    const warningText = entry.body.length > 1 ? entry.body.slice(0, -1).join("\n\n") : "";
    const warningHtml = warningText ? escapeHtml(warningText) + "<br><br>" : "";
    
    const shimmerHtml = `
      <div class="thinking-ux">
        <div class="thinking-step"><span class="thinking-dot shimmer"></span><span class="step-text">Collecting index</span></div>
        <div class="thinking-step"><span class="thinking-dot shimmer"></span><span class="step-text">Evaluating over index</span></div>
        <div class="thinking-step"><span class="thinking-dot shimmer"></span><span class="step-text">Articulating for you</span></div>
      </div>
    `;
    return warningHtml + shimmerHtml;
  }
  
  if (entry.format === "markdown") {
    // marked.parse can return string | Promise<string> but synchronously returns string
    return marked.parse(entry.body.join("\n\n")) as string;
  }

  return escapeHtml(entry.body.join("\n\n"));
}

// ── HTML shell ────────────────────────────────────────────────────────────────

function renderHtml(state: PanelState): string {
  const nonce = createNonce();
  const sections = buildSections(state);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Corrdex AI</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --surface: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground) 8%);
      --surface-2: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-editor-foreground) 14%);
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-textLink-foreground);
    }
    *, *::before, *::after {
      box-sizing: border-box;
      min-width: 0;
    }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      background: var(--bg);
      color: var(--text);
    }

    /* ── Messages area ── */
    .messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      padding: 16px 14px 8px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* ── Empty state ── */
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: var(--muted);
      text-align: center;
      padding: 40px 20px;
    }
    .empty-icon { opacity: 0.5; }
    .empty-label { font-size: 13px; }
    .empty-hint { font-size: 11px; opacity: 0.7; }

    /* ── Message pairs ── */
    .message-pair {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .user-bubble-wrapper {
      align-self: flex-end;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
      max-width: 85%;
    }
    .user-bubble-wrapper .edit-msg {
      opacity: 0;
      transition: opacity 0.2s;
    }
    .user-bubble-wrapper:hover .edit-msg {
      opacity: 1;
    }
    .user-bubble {
      background: color-mix(in srgb, var(--accent) 18%, var(--surface));
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
      border-radius: 14px 14px 4px 14px;
      padding: 8px 12px;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .ai-bubble {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ai-body {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px 14px 14px 14px;
      padding: 10px 13px;
      font-size: 13px;
      line-height: 1.6;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .ai-body.markdown {
      white-space: normal;
    }
    .ai-body.markdown p {
      margin-top: 0;
      margin-bottom: 10px;
    }
    .ai-body.markdown p:last-child {
      margin-bottom: 0;
    }
    .ai-body.markdown ul, .ai-body.markdown ol {
      margin-top: 0;
      margin-bottom: 10px;
      padding-left: 24px;
    }
    .ai-body.markdown li {
      margin-bottom: 4px;
    }
    .ai-body.markdown code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: color-mix(in srgb, var(--text) 8%, transparent);
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 12px;
    }
    .ai-body.markdown pre {
      background: color-mix(in srgb, var(--text) 5%, transparent);
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      margin-top: 0;
      margin-bottom: 10px;
    }
    .ai-body.markdown pre code {
      background: transparent;
      padding: 0;
      font-size: 12px;
    }
    .ai-body.markdown a {
      color: var(--accent);
      text-decoration: none;
    }
    .ai-body.markdown a:hover {
      text-decoration: underline;
    }
    .ai-body.pending {
      opacity: 0.92;
    }
    .abort-wrapper {
      margin-top: 10px;
      display: flex;
      justify-content: center;
    }
    .abort-msg {
      border: 1px solid var(--border) !important;
      background: var(--bg) !important;
      padding: 4px 8px !important;
      border-radius: 6px !important;
    }
    .ai-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-left: 4px;
    }
    .ai-footer .copy-msg {
      opacity: 0;
      transition: opacity 0.2s;
    }
    .ai-bubble:hover .copy-msg {
      opacity: 1;
    }
    .ai-source {
      font-size: 11px;
      color: var(--muted);
    }

    /* ── Thinking UX ── */
    .thinking-ux {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 8px 4px;
    }
    .thinking-step {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
    }
    .thinking-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--surface-2);
      flex-shrink: 0;
    }
    .step-text {
      color: var(--muted);
      background: linear-gradient(90deg, var(--muted) 0%, var(--text) 20%, var(--muted) 40%);
      background-size: 200% 100%;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: text-shimmer 2.5s infinite linear;
    }
    .thinking-dot.shimmer {
      animation: dot-shimmer 2.5s infinite linear;
    }
    .thinking-step:nth-child(1) .step-text, .thinking-step:nth-child(1) .thinking-dot.shimmer { animation-delay: 0s; }
    .thinking-step:nth-child(2) .step-text, .thinking-step:nth-child(2) .thinking-dot.shimmer { animation-delay: 0.8s; }
    .thinking-step:nth-child(3) .step-text, .thinking-step:nth-child(3) .thinking-dot.shimmer { animation-delay: 1.6s; }

    @keyframes text-shimmer {
      0% { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }
    @keyframes dot-shimmer {
      0%, 100% { background: var(--surface-2); box-shadow: none; }
      10% { background: var(--text); box-shadow: 0 0 8px 2px color-mix(in srgb, var(--text) 50%, transparent); }
      30% { background: var(--surface-2); box-shadow: none; }
    }

    /* ── Input area (pinned to bottom) ── */
    .input-area {
      flex-shrink: 0;
      border-top: 1px solid var(--border);
      padding: 10px 12px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--bg);
    }

    /* ── Scope + status row ── */
    .scope-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .scope-label {
      font-size: 11px;
      color: var(--muted);
    }
    select {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 3px 6px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .status-warn {
      font-size: 11px;
      color: #c98b1f;
      overflow-wrap: anywhere;
    }

    /* ── Composer ── */
    .composer-row {
      display: grid;
      gap: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
    }
    .composer-main {
      display: flex;
      align-items: flex-end;
      gap: 6px;
    }
    textarea {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      resize: none;
      min-height: 52px;
      max-height: 200px;
      overflow-y: auto;
      line-height: 1.5;
    }
    textarea::placeholder { color: var(--muted); }
    .send-btn {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: none;
      background: color-mix(in srgb, var(--accent) 90%, transparent);
      color: var(--bg);
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.15s;
    }
    .send-btn:hover { opacity: 0.85; }

    /* ── Footer actions ── */
    .footer-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex-wrap: wrap;
    }
    button.action {
      background: transparent;
      color: var(--muted);
      border: none;
      padding: 2px 4px;
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
      font-size: 11px;
    }
    button.action:hover { color: var(--text); background: var(--surface-2); }

    /* ── Prompt chips ── */
    .prompt-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      background: var(--surface-2);
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      white-space: normal;
      text-align: left;
      transition: color 0.1s;
    }
    .chip:hover { color: var(--text); }
  </style>
</head>
<body>
  <!-- Chat History Header -->
  <div class="chat-header" style="display: flex; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--surface-2); align-items: center;">
    <select id="chat-select" title="Chat History" style="flex: 1;">
      ${sections["crd-chat-options"]}
    </select>
    <button class="action" id="new-chat" type="button" title="New Chat" style="display: flex; align-items: center; padding: 4px;">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z"/></svg>
    </button>
    <button class="action" id="clear-history" type="button" title="Clear History" style="display: flex; align-items: center; padding: 4px;">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H12v9A1.5 1.5 0 0 1 10.5 15h-5A1.5 1.5 0 0 1 4 13.5V4.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 4.5v9c0 .28.223.5.496.5h5.016a.496.496 0 0 0 .496-.496V4.5H4.496ZM6.5 1.5V3h3V1.5a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Zm1 5.5v5a.75.75 0 0 1-1.5 0v-5a.75.75 0 0 1 1.5 0Zm3 0v5a.75.75 0 0 1-1.5 0v-5a.75.75 0 0 1 1.5 0Z"/></svg>
    </button>
  </div>

  <!-- Scrollable messages area -->
  <div class="messages" id="crd-messages">${sections["crd-messages"]}</div>

  <!-- Input area pinned to bottom -->
  <div class="input-area">
    <div class="scope-row">
      <select id="scope" title="Context scope">
        <option value="current-file"${state.selectedScope === "current-file" ? " selected" : ""}>Current file</option>
        <option value="project-overview"${state.selectedScope === "project-overview" ? " selected" : ""}>Project overview</option>
      </select>
      <div id="crd-remote-status">${sections["crd-remote-status"]}</div>
    </div>

    <div class="composer-row">
      <div class="composer-main">
      <textarea
        id="question"
        rows="2"
        placeholder="Ask anything about this codebase, file, workflow, risk, or refactor path"
      ></textarea>
      </div>
      
      <div class="footer-row">
        <div class="footer-actions">
          <button class="action" id="open-settings" type="button">AI Settings</button>
          <button class="action" id="set-api-key" type="button">Set API Key</button>
          <button class="action" id="refresh" type="button" title="Refresh context">↻ Refresh</button>
          <button class="action" id="push-index" type="button" title="Push Index to Server">☁ Push</button>
        </div>

        <button class="send-btn" id="ask" type="button" title="Send (Enter)">&#x2191;</button>
</div>
    </div>

    <div class="prompt-row" id="crd-prompts">${sections["crd-prompts"]}</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const questionEl = document.getElementById('question');
    const scopeEl = document.getElementById('scope');
    const chatSelectEl = document.getElementById('chat-select');

    // Auto-resize textarea
    function resizeTextarea() {
      questionEl.style.height = 'auto';
      questionEl.style.height = Math.min(questionEl.scrollHeight, 140) + 'px';
    }
    questionEl?.addEventListener('input', resizeTextarea);

    // Static button wiring
    document.getElementById('new-chat')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'newChat' });
    });
    document.getElementById('clear-history')?.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all chat history?')) {
        vscode.postMessage({ type: 'clearHistory' });
      }
    });
    chatSelectEl?.addEventListener('change', () => {
      if (chatSelectEl.value) {
        vscode.postMessage({ type: 'loadChat', chatId: chatSelectEl.value });
      }
    });
    document.getElementById('refresh')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('open-settings')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'openSettings' });
    });
    document.getElementById('set-api-key')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'setApiKey' });
    });
    document.getElementById('push-index')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'pushIndex' });
    });
    scopeEl?.addEventListener('change', () => {
      vscode.postMessage({ type: 'setScope', scope: scopeEl.value });
    });

    function submitQuestion() {
      const query = (questionEl?.value ?? '').trim();
      if (!query) return;
      vscode.postMessage({ type: 'ask', query, scope: scopeEl?.value ?? 'current-file' });
      if (questionEl) {
        questionEl.value = '';
        resizeTextarea();
      }
    }

    document.getElementById('ask')?.addEventListener('click', submitQuestion);
    questionEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitQuestion();
      }
    });

    // Message area actions — event delegation
    document.getElementById('crd-messages')?.addEventListener('click', (e) => {
      const target = e.target;
      
      // Handle Copy
      const copyBtn = target.closest('.copy-msg');
      if (copyBtn) {
        const rawText = copyBtn.getAttribute('data-raw') ?? '';
        vscode.postMessage({ type: 'copy', query: rawText });
        return;
      }
      
      // Handle Abort
      const abortBtn = target.closest('.abort-msg');
      if (abortBtn) {
        vscode.postMessage({ type: 'abort' });
        return;
      }
      
      // Handle Edit Last
      const editBtn = target.closest('.edit-msg');
      if (editBtn) {
        vscode.postMessage({ type: 'editLast' });
        return;
      }
    });

    // Prompt chips — event delegation so re-renders don't break listeners
    document.getElementById('crd-prompts')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-prompt]');
      if (!chip) return;
      const query = chip.getAttribute('data-prompt') ?? '';
      vscode.postMessage({ type: 'ask', query, scope: scopeEl?.value ?? 'current-file' });
    });

    // Scroll messages to top when new message arrives (newest-first layout)
    function scrollMessagesToBottom() {
      const msgs = document.getElementById('crd-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }

    // State update handler — patches containers without touching the full DOM
    window.addEventListener('message', (event) => {
      const msg = event.data;
      
      if (msg.type === 'populateInput' && questionEl) {
        questionEl.value = msg.text;
        resizeTextarea();
        questionEl.focus();
        return;
      }

      if (msg.type !== 'stateUpdate') return;

      const { sections, scopeValue } = msg;

      for (const [id, html] of Object.entries(sections)) {
        if (id === 'crd-chat-options' && chatSelectEl) {
          chatSelectEl.innerHTML = html;
          continue;
        }
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
      }

      if (scopeValue && scopeEl) scopeEl.value = scopeValue;

      scrollMessagesToBottom();
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

// ── Local answer builders ─────────────────────────────────────────────────────

function answerLocalCurrentFile(question: string, snapshot: FileContextSnapshot): AskResult {
  const normalizedQuestion = question.trim().toLowerCase();
  const suggestions = buildFilePromptSuggestions(snapshot);

  if (!normalizedQuestion) {
    return { title: "", body: [], suggestions };
  }

  if (matchesAny(normalizedQuestion, ["risk", "risky", "warning", "finding", "violation", "diagnostic"])) {
    return { title: "Risk & Diagnostics", body: buildRiskAnswer(snapshot), suggestions };
  }

  if (matchesAny(normalizedQuestion, ["function", "method"])) {
    return { title: "Detected Functions", body: buildFunctionAnswer(snapshot), suggestions };
  }

  if (matchesAny(normalizedQuestion, ["why", "classified", "classification", "type", "evidence", "reason"])) {
    return { title: "Classification", body: buildTypeAnswer(snapshot), suggestions };
  }

  if (matchesAny(normalizedQuestion, ["depend", "import", "repo", "repository", "module"])) {
    return { title: "Dependencies", body: buildDependencyAnswer(snapshot), suggestions };
  }

  return {
    title: "Corrdex AI",
    body: [buildSummary(snapshot)],
    suggestions,
  };
}

function buildSummary(snapshot: FileContextSnapshot): string {
  const topBehaviors = snapshot.behaviors
    .slice(0, 3)
    .map((b) => `${b.type} (${Math.round(b.confidence * 100)}%)`);
  const liveSummary = snapshot.liveProjectViolationSummary;
  const scopeLabel = describeLocalScope(snapshot);
  const findingSummary = snapshot.findings.length === 0
    ? "no architectural findings"
    : `${snapshot.findings.length} architectural finding${snapshot.findings.length === 1 ? "" : "s"}`;
  return `${path.basename(snapshot.filePath)} is classified as ${snapshot.primaryType} with ${Math.round(snapshot.confidence * 100)}% confidence. It shows ${topBehaviors.length > 0 ? topBehaviors.join(", ") : "no strong behaviors"}, has ${snapshot.dependencyCounts.internal} internal and ${snapshot.dependencyCounts.external} external dependencies, and currently has ${snapshot.diagnostics.length} live local violation${snapshot.diagnostics.length === 1 ? "" : "s"} in this file with ${findingSummary}. ${scopeLabel} Corrdex sees ${liveSummary.totalOpen} live violation${liveSummary.totalOpen === 1 ? "" : "s"}.`;
}

function buildTypeAnswer(snapshot: FileContextSnapshot): string[] {
  const lines = [
    `${path.basename(snapshot.filePath)} is classified as ${snapshot.primaryType} with ${Math.round(snapshot.confidence * 100)}% confidence.`,
  ];
  if (snapshot.reasoningChain.length > 0) {
    lines.push(`Strongest signals: ${snapshot.reasoningChain.slice(0, 4).join(" | ")}.`);
  }
  const topBehaviors = snapshot.behaviors.slice(0, 4);
  if (topBehaviors.length > 0) {
    lines.push(`Top behaviors: ${topBehaviors.map((b) => `${b.type} ${Math.round(b.confidence * 100)}%`).join(", ")}.`);
  }
  if (snapshot.roles.length > 0) {
    lines.push(`Architectural roles: ${snapshot.roles.map((r) => `${r.type} ${Math.round(r.confidence * 100)}%`).join(", ")}.`);
  }
  return lines;
}

function buildRiskAnswer(snapshot: FileContextSnapshot): string[] {
  const lines: string[] = [];
  const scopeLabel = describeLocalScope(snapshot);
  if (snapshot.findings.length === 0 && snapshot.diagnostics.length === 0) {
    lines.push("No architectural findings or live local violations on this file.");
    const liveSummary = snapshot.liveProjectViolationSummary;
    if (liveSummary.totalOpen > 0) {
      lines.push(`${scopeLabel} Corrdex still sees ${liveSummary.totalOpen} live violation${liveSummary.totalOpen === 1 ? "" : "s"}.`);
    }
    return lines;
  }
  if (snapshot.findings.length > 0) {
    const findings = snapshot.findings
      .slice(0, 4)
      .map((f) => `${f.type} (${f.severity}, ${Math.round(f.confidence * 100)}%)${f.description ? `: ${f.description}` : ""}`);
    lines.push(`Architectural findings: ${findings.join(" | ")}.`);
  }
  if (snapshot.diagnostics.length > 0) {
    const diagnostics = snapshot.diagnostics
      .slice(0, 4)
      .map((d) => `${d.ruleId} at L${d.line}:${d.column} (${d.severity})`);
    lines.push(`Live local violations in this file: ${diagnostics.join(" | ")}.`);
  }
  const liveSummary = snapshot.liveProjectViolationSummary;
  if (liveSummary.totalOpen > snapshot.diagnostics.length) {
    const topRules = Object.entries(liveSummary.countsByRule)
      .slice(0, 3)
      .map(([ruleId, count]) => `${ruleId} (${count})`);
    lines.push(`${scopeLabel} Corrdex sees ${liveSummary.totalOpen} live violation${liveSummary.totalOpen === 1 ? "" : "s"}${topRules.length > 0 ? `, led by ${topRules.join(" | ")}` : ""}.`);
  }
  return lines;
}

function buildFunctionAnswer(snapshot: FileContextSnapshot): string[] {
  if (snapshot.functions.length === 0) {
    return ["No top-level functions detected for this file in the current snapshot."];
  }
  return [
    `${snapshot.functions.length} function${snapshot.functions.length === 1 ? "" : "s"} detected:`,
    ...snapshot.functions.slice(0, 8).map((fn) => {
      const name = fn.name ?? fn.stableId;
      const params = fn.parameterNames.length > 0 ? `(${fn.parameterNames.join(", ")})` : "()";
      return `${name}${params} — ${fn.kind} at L${fn.startLine}–${fn.endLine}`;
    }),
  ];
}

function buildDependencyAnswer(snapshot: FileContextSnapshot): string[] {
  const lines = [
    `${path.basename(snapshot.filePath)} has ${snapshot.dependencyCounts.internal} internal and ${snapshot.dependencyCounts.external} external dependencies.`,
  ];
  if (snapshot.findings.some((f) => f.type.includes("coupling"))) {
    lines.push("Corrdex is flagging coupling pressure — the dependency surface may be spreading across too many responsibilities.");
  }
  if (snapshot.behaviors.some((b) => b.type.startsWith("database-"))) {
    lines.push("Database behaviors detected — verify that DB dependencies belong in this layer and not behind a repository boundary.");
  }
  return lines;
}

function buildCapabilityAnswer(
  scope: AskScope,
  snapshot: FileContextSnapshot | null,
  remoteConfig: RemoteConfig,
): AskResult {
  const suggestions = buildSuggestionsForScope(scope, snapshot);

  if (scope === "project-overview") {
    const lines = [
      "I can answer codebase-level questions about architecture, risky areas, coupling, modules, violations, and refactor priorities.",
      "I can compare your live local workspace signal with shared remote project state when the question is about risks, findings, or rules.",
      remoteConfig.ok
        ? "Project overview questions use the remote Corrdex AI backend, so they can cover the indexed codebase instead of just the active file."
        : "Project overview is not configured yet. Set the server base URL, project ID, and AI API key to enable full codebase answers.",
      "Good prompts: 'What are the riskiest parts right now?', 'Summarize the architecture', 'Which modules look unhealthy?', 'Tell me any rule breaking'.",
    ];

    return {
      title: "What Corrdex AI Can Do",
      body: lines,
      suggestions,
      sourceLabel: remoteConfig.ok ? "Corrdex AI capabilities" : "Corrdex AI capabilities · project overview unavailable",
    };
  }

  const lines = [
    snapshot
      ? `I can explain ${path.basename(snapshot.filePath)}: why it was classified this way, which functions Corrdex detected, what dependencies it has, and what findings or live violations are active.`
      : "I can explain the active file when it is a supported code file.",
    "I can answer file-level questions about classification, dependencies, functions, findings, and live local rule violations.",
    "Good prompts: 'Why is this file classified this way?', 'What functions were detected?', 'What are the riskiest parts here?', 'What live violations are active right now?'.",
  ];

  return {
    title: "What Corrdex AI Can Do",
    body: lines,
    suggestions,
    sourceLabel: snapshot ? buildLocalSourceLabel(snapshot) : "Corrdex AI capabilities",
  };
}

function buildFilePromptSuggestions(snapshot?: FileContextSnapshot): string[] {
  const prompts = [
    "What can you do here?",
    "Why is this file classified this way?",
    "What are the riskiest parts here?",
    "What functions were detected?",
    "What live violations are active right now?",
  ];
  if (snapshot && snapshot.findings.length > 0) {
    prompts.push(`Explain ${snapshot.findings[0]!.type} in this file`);
  }
  return prompts.slice(0, 5);
}

function buildProjectPromptSuggestions(): string[] {
  return [
    "What can you do for this codebase?",
    "What are the riskiest parts of this codebase right now?",
    "What does my current workspace violate right now versus shared remote state?",
    "What architectural problems should the team fix first?",
    "Which modules look most coupled or unhealthy?",
    "Summarize the current architecture in plain English.",
  ];
}

function buildLocalWorkspaceWarning(snapshot: FileContextSnapshot | null, question: string): string | null {
  if (!snapshot) {
    return null;
  }

  if (!matchesAny(question.toLowerCase(), ["risk", "risky", "warning", "finding", "violation", "diagnostic", "rule"])) {
    return null;
  }

  const liveSummary = snapshot.liveProjectViolationSummary;
  return `Local workspace note: ${describeLocalScope(snapshot)} Corrdex currently sees ${liveSummary.totalOpen} live violation${liveSummary.totalOpen === 1 ? "" : "s"}. The project overview below is shared remote state and may differ from your current branch or unsaved workspace.`;
}

function buildLocalSourceLabel(snapshot: FileContextSnapshot): string {
  return `Local current file · ${snapshot.liveProjectViolationSummary.sourceScope}`;
}

function describeLocalScope(snapshot: FileContextSnapshot): string {
  const liveSummary = snapshot.liveProjectViolationSummary;
  if (liveSummary.sourceScope === "workspace-index") {
    return `Across the workspace index (${liveSummary.analyzedFileCount} file${liveSummary.analyzedFileCount === 1 ? "" : "s"}),`;
  }

  return `Across analyzed open documents (${liveSummary.analyzedFileCount} file${liveSummary.analyzedFileCount === 1 ? "" : "s"}),`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function matchesAny(question: string, terms: string[]): boolean {
  return terms.some((term) => question.includes(term));
}

function isCapabilityQuestion(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    matchesAny(normalized, ["what can you do", "help me", "how can you help", "capabilities"]) ||
    (normalized.includes("what") && normalized.includes("do") && normalized.includes("here")) ||
    (normalized.includes("what") && normalized.includes("do") && normalized.includes("codebase"))
  );
}

function normalizeScope(scope: AskScope | string | undefined): AskScope {
  return scope === "project-overview" ? "project-overview" : "current-file";
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return ["typescript", "javascript", "typescriptreact", "javascriptreact", "python"].includes(document.languageId);
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

function buildSuggestionsForScope(scope: AskScope, snapshot: FileContextSnapshot | null): string[] {
  return scope === "project-overview"
    ? buildProjectPromptSuggestions()
    : buildFilePromptSuggestions(snapshot ?? undefined);
}

function isLocalHistoryEntry(entry: HistoryEntry): boolean {
  return entry.sourceLabel?.startsWith("Local current file") ?? false;
}

function buildRemoteSourceLabel(provider?: string, model?: string): string {
  const sourceBits = [provider?.trim(), model?.trim()].filter(Boolean);
  return sourceBits.length > 0
    ? `${sourceBits.join(" · ")} · shared remote state`
    : "Remote project overview · shared remote state";
}

function parseSSEEvent(rawEvent: string): { event: string; data: string } | null {
  const lines = rawEvent
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  return {
    event,
    data: dataLines.join("\n"),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getActiveWorkspaceScopeUri(): vscode.Uri | undefined {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri) {
    const editorFolder = vscode.workspace.getWorkspaceFolder(editorUri);
    if (editorFolder) {
      return editorFolder.uri;
    }
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getWorkspaceScopeLabel(scopeUri: vscode.Uri | undefined): string | undefined {
  if (!scopeUri) {
    return undefined;
  }

  return vscode.workspace.getWorkspaceFolder(scopeUri)?.name ?? path.basename(scopeUri.fsPath);
}

async function readProjectIdFromCorrdexConfig(scopeUri: vscode.Uri | undefined): Promise<string> {
  if (!scopeUri) {
    return "";
  }

  const configUri = vscode.Uri.joinPath(scopeUri, "corrdex.config.json");
  try {
    const bytes = await vscode.workspace.fs.readFile(configUri);
    const raw = Buffer.from(bytes).toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      return "";
    }

    const topLevelProjectId = typeof parsed.projectId === "string" ? parsed.projectId.trim() : "";
    if (topLevelProjectId) {
      return topLevelProjectId;
    }

    const aiSection = isPlainObject(parsed.ai) ? parsed.ai : undefined;
    return typeof aiSection?.projectId === "string" ? aiSection.projectId.trim() : "";
  } catch {
    return "";
  }
}

function buildProjectScopedSecretKey(projectId: string): string {
  return `${AI_API_KEY_SECRET_KEY}.project.${projectId}`;
}

function buildWorkspaceScopedSecretKey(scopeUri: vscode.Uri): string {
  return `${AI_API_KEY_SECRET_KEY}.workspace.${Buffer.from(scopeUri.toString()).toString("base64url")}`;
}

export async function readScopedAIApiKey(
  context: ExtensionContext,
  projectId: string,
  scopeUri: vscode.Uri | undefined,
): Promise<string> {
  const candidateKeys = [
    ...(projectId ? [buildProjectScopedSecretKey(projectId)] : []),
    ...(scopeUri ? [buildWorkspaceScopedSecretKey(scopeUri)] : []),
    AI_API_KEY_SECRET_KEY,
    AI_API_KEY_SECRET_KEY,
  ];

  for (const secretKey of candidateKeys) {
    const value = (await context.secrets.get(secretKey))?.trim();
    if (value) {
      return value;
    }
  }

  return "";
}

async function storeScopedAIApiKey(
  context: ExtensionContext,
  apiKey: string,
  projectId: string,
  scopeUri: vscode.Uri | undefined,
): Promise<void> {
  if (projectId) {
    await context.secrets.store(buildProjectScopedSecretKey(projectId), apiKey);
    return;
  }

  if (scopeUri) {
    await context.secrets.store(buildWorkspaceScopedSecretKey(scopeUri), apiKey);
    return;
  }

  await context.secrets.store(AI_API_KEY_SECRET_KEY, apiKey);
}

async function clearScopedAIApiKey(
  context: ExtensionContext,
  projectId: string,
  scopeUri: vscode.Uri | undefined,
): Promise<void> {
  if (!projectId && !scopeUri) {
    await context.secrets.delete(AI_API_KEY_SECRET_KEY);
    await context.secrets.delete(AI_API_KEY_SECRET_KEY);
    return;
  }

  const candidateKeys = [
    ...(projectId ? [buildProjectScopedSecretKey(projectId)] : []),
    ...(scopeUri ? [buildWorkspaceScopedSecretKey(scopeUri)] : []),
    AI_API_KEY_SECRET_KEY,
    AI_API_KEY_SECRET_KEY,
  ];

  for (const secretKey of candidateKeys) {
    if (secretKey === AI_API_KEY_SECRET_KEY) {
      continue;
    }
    await context.secrets.delete(secretKey);
  }
}

function createNonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
