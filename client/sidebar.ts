import * as path from "path";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node.js";

import { GET_SIDEBAR_SNAPSHOT_REQUEST, type SidebarSnapshot } from "../extensionProtocol.js";

type SidebarNode =
    | SummaryNode
    | GroupNode
    | DetailNode;

interface SummaryNode {
    kind: "summary";
    label: string;
    description?: string;
    tooltip?: string;
    icon?: vscode.ThemeIcon;
}

interface GroupNode {
    kind: "group";
    label: string;
    description?: string;
    tooltip?: string;
    children: DetailNode[];
    expanded?: boolean;
    icon?: vscode.ThemeIcon;
}

interface DetailNode {
    kind: "detail";
    label: string;
    description?: string;
    tooltip?: string;
    icon?: vscode.ThemeIcon;
    command?: vscode.Command;
}

export class CorrdexSidebarProvider implements vscode.TreeDataProvider<SidebarNode> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SidebarNode | undefined | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    private lastRootItems: SidebarNode[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly client: LanguageClient,
    ) {}

    refresh(): void {
        void this.rebuild();
    }

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }

    getTreeItem(element: SidebarNode): vscode.TreeItem {
        if (element.kind === "group") {
            const item = new vscode.TreeItem(
                element.label,
                element.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
            );
            item.description = element.description;
            item.tooltip = element.tooltip;
            item.iconPath = element.icon;
            return item;
        }

        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.tooltip = element.tooltip;
        item.iconPath = element.icon;
        if (element.kind === "detail" && element.command) {
            item.command = element.command;
        }
        return item;
    }

    getChildren(element?: SidebarNode): Thenable<SidebarNode[]> {
        if (!element) {
            return this.rebuild().then(() => this.lastRootItems);
        }

        if (element.kind === "group") {
            return Promise.resolve(element.children);
        }

        return Promise.resolve([]);
    }

    private async rebuild(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSupportedDocument(editor.document)) {
            this.lastRootItems = [
                {
                    kind: "summary",
                    label: "No supported active file",
                    description: "Open a TS, JS, or Python file",
                    tooltip: "Corrdex sidebar updates from the active editor.",
                    icon: new vscode.ThemeIcon("info"),
                },
            ];
            this.onDidChangeTreeDataEmitter.fire();
            return;
        }

        const document = editor.document;
        const snapshot = await this.client.sendRequest<SidebarSnapshot | null>(
            GET_SIDEBAR_SNAPSHOT_REQUEST,
            { uri: document.uri.toString() },
        );

        this.lastRootItems = buildSidebarItems(document.uri.fsPath, snapshot);
        this.onDidChangeTreeDataEmitter.fire();
    }
}

function buildSidebarItems(
    filePath: string,
    snapshot: SidebarSnapshot | null,
): SidebarNode[] {
    if (!snapshot) {
        return [
            {
                kind: "summary",
                label: path.basename(filePath),
                description: "No classification available",
                tooltip: normalizePath(filePath),
                icon: new vscode.ThemeIcon("question"),
            },
        ];
    }

    const items: SidebarNode[] = [
        {
            kind: "summary",
            label: path.basename(filePath),
            description: snapshot.primaryType,
            tooltip: normalizePath(filePath),
            icon: new vscode.ThemeIcon("file-code"),
        },
        {
            kind: "summary",
            label: "Primary Type",
            description: `${snapshot.primaryType} (${formatPercent(snapshot.confidence)})`,
            tooltip: `Confidence: ${formatPercent(snapshot.confidence)}`,
            icon: new vscode.ThemeIcon("symbol-class"),
        },
        {
            kind: "summary",
            label: "Dependencies",
            description: `${snapshot.dependencyCounts.internal} internal, ${snapshot.dependencyCounts.external} external`,
            tooltip: "Dependency profile for the active file.",
            icon: new vscode.ThemeIcon("references"),
        },
        buildBehaviorsGroup(snapshot),
        buildRolesGroup(snapshot),
        buildFindingsGroup(snapshot),
        buildDiagnosticsGroup(filePath, snapshot),
    ];

    return items;
}

function buildBehaviorsGroup(snapshot: SidebarSnapshot): GroupNode {
    const topBehaviors = snapshot.behaviors;
    return {
        kind: "group",
        label: "Behaviors",
        description: topBehaviors.length === 0 ? "none" : `${topBehaviors.length}`,
        expanded: true,
        icon: new vscode.ThemeIcon("symbol-method"),
        children: topBehaviors.length === 0
            ? [createInfoNode("No behaviors detected")]
            : topBehaviors.map((behavior) => ({
                kind: "detail",
                label: behavior.type,
                description: formatPercent(behavior.confidence),
                tooltip: behavior.evidence.join("\n"),
                icon: new vscode.ThemeIcon("circle-large-outline"),
            })),
    };
}

function buildRolesGroup(snapshot: SidebarSnapshot): GroupNode {
    const roles = snapshot.roles;
    return {
        kind: "group",
        label: "Architectural Roles",
        description: roles.length === 0 ? "none" : `${roles.length}`,
        expanded: false,
        icon: new vscode.ThemeIcon("organization"),
        children: roles.length === 0
            ? [createInfoNode("No architectural roles inferred")]
            : roles.map((role) => ({
                kind: "detail",
                label: role.type,
                description: formatPercent(role.confidence),
                tooltip: role.evidence.join("\n"),
                icon: new vscode.ThemeIcon("circle-large-outline"),
            })),
    };
}

function buildFindingsGroup(snapshot: SidebarSnapshot): GroupNode {
    const findings = snapshot.findings;
    return {
        kind: "group",
        label: "Findings",
        description: findings.length === 0 ? "none" : `${findings.length}`,
        expanded: false,
        icon: new vscode.ThemeIcon("warning"),
        children: findings.length === 0
            ? [createInfoNode("No architectural findings")]
            : findings.map((finding) => ({
                kind: "detail",
                label: finding.type,
                description: `${finding.severity} ${formatPercent(finding.confidence)}`,
                tooltip: [finding.description, ...(finding.evidence ?? [])].filter(Boolean).join("\n"),
                icon: severityIcon(finding.severity),
            })),
    };
}

function buildDiagnosticsGroup(filePath: string, snapshot: SidebarSnapshot): GroupNode {
    const sortedDiagnostics = snapshot.diagnostics;
    return {
        kind: "group",
        label: "Diagnostics",
        description: sortedDiagnostics.length === 0 ? "clean" : `${sortedDiagnostics.length}`,
        expanded: true,
        icon: new vscode.ThemeIcon("issues"),
        children: sortedDiagnostics.length === 0
            ? [createInfoNode("No Corrdex diagnostics on this file")]
            : sortedDiagnostics.map((diagnostic) => ({
                kind: "detail",
                label: diagnostic.ruleId,
                description: `L${diagnostic.line}:${diagnostic.column}`,
                tooltip: diagnostic.message,
                icon: severityIcon(diagnostic.severity),
                command: {
                    command: "corrdex.openDiagnostic",
                    title: "Open diagnostic",
                    arguments: [filePath, diagnostic.line, diagnostic.column],
                },
            })),
    };
}

function createInfoNode(label: string): DetailNode {
    return {
        kind: "detail",
        label,
        icon: new vscode.ThemeIcon("info"),
    };
}

function severityIcon(severity: SidebarSnapshot["diagnostics"][number]["severity"] | "warning" | "error" | "info"): vscode.ThemeIcon {
    if (severity === "error") {
        return new vscode.ThemeIcon("error");
    }
    if (severity === "info") {
        return new vscode.ThemeIcon("info");
    }
    return new vscode.ThemeIcon("warning");
}

function normalizePath(filePath: string): string {
    return path.normalize(filePath);
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
    return ["typescript", "javascript", "typescriptreact", "javascriptreact", "python"].includes(document.languageId);
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}
