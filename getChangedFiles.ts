import { execSync } from "child_process";
import path from "path";

export interface DiffOptions {
    staged?: boolean;
    branch?: string;
}

/**
 * Executes a git diff command to find modified files.
 * @param options DiffOptions to control if checking staged or a branch
 * @param cwd The working directory to resolve paths against
 * @returns Array of absolute paths to modified TS/JS files, or null if git fails
 */
export function getChangedFiles(options: DiffOptions, cwd: string): string[] | null {
    try {
        let command = "";
        
        if (options.staged) {
            command = "git diff --cached --name-only";
        } else if (options.branch) {
            command = `git diff ${options.branch} --name-only`;
        } else {
            return null; // Should not happen based on CLI logic
        }

        const output = execSync(command, { cwd, encoding: "utf-8" });
        
        const files = output.split("\n")
            .map(f => f.trim())
            .filter(f => f.length > 0)
            .filter(f => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".sql") || f.endsWith(".py"))
            .map(f => path.resolve(cwd, f));
            
        return files;
    } catch (error) {
        // Either git is not installed, not a repo, or the branch doesn't exist
        return null;
    }
}
