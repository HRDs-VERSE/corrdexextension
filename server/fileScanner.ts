import fs from "fs";
import path from "path";

export function findProjectRoot(startDir: string): string {
    let currentDir = path.resolve(startDir);
    let nearestProjectRoot: string | undefined;
    let workspaceRoot: string | undefined;

    while (true) {
        const hasCorrdexConfig = fs.existsSync(path.join(currentDir, "corrdex.config.json"));
        const hasMergeLensConfig = fs.existsSync(path.join(currentDir, "mergelens.config.json"));
        const hasPackageJson = fs.existsSync(path.join(currentDir, "package.json"));
        const hasTsConfig = fs.existsSync(path.join(currentDir, "tsconfig.json"));

        if ((hasCorrdexConfig || hasMergeLensConfig || hasPackageJson || hasTsConfig) && !nearestProjectRoot) {
            nearestProjectRoot = currentDir;
        }

        if (hasWorkspaceRootMarkers(currentDir, hasPackageJson)) {
            workspaceRoot = currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            return workspaceRoot || nearestProjectRoot || startDir;
        }

        currentDir = parentDir;
    }
}

function hasWorkspaceRootMarkers(currentDir: string, hasPackageJson: boolean): boolean {
    if (
        fs.existsSync(path.join(currentDir, "pnpm-workspace.yaml")) ||
        fs.existsSync(path.join(currentDir, "lerna.json")) ||
        fs.existsSync(path.join(currentDir, "nx.json")) ||
        fs.existsSync(path.join(currentDir, "turbo.json")) ||
        fs.existsSync(path.join(currentDir, "rush.json"))
    ) {
        return true;
    }

    if (!hasPackageJson) {
        return false;
    }

    try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(currentDir, "package.json"), "utf-8"));
        return Boolean(packageJson.workspaces);
    } catch {
        return false;
    }
}

export function collectProjectSourceFiles(rootDir: string): string[] {
    const files: string[] = [];

    visitDirectory(rootDir, files);

    return files.sort((left, right) => left.localeCompare(right));
}

function isAnalyzableSourceFile(filePath: string): boolean {
    const fileName = path.basename(filePath);
    if (fileName === ".corrdex-cache.json") {
        return false;
    }

    return (
        filePath.endsWith(".ts") ||
        filePath.endsWith(".js") ||
        filePath.endsWith(".sql") ||
        filePath.endsWith(".py") ||
        filePath.endsWith(".json")
    );
}

function visitDirectory(currentDir: string, files: string[]): void {
    if (!fs.existsSync(currentDir)) {
        return;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const absolutePath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === ".venv" || entry.name === "venv" || entry.name === "__pycache__") {
                continue;
            }

            visitDirectory(absolutePath, files);
            continue;
        }

        if (entry.isFile() && isAnalyzableSourceFile(absolutePath)) {
            files.push(absolutePath);
        }
    }
}
export function normalizeProjectFileKey(projectRoot: string, filePath: string): string { 
    return path.relative(projectRoot, path.resolve(filePath)).replace(/\\/g, "/"); 
}
