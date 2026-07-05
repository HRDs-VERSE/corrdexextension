import crypto from "crypto";
import { parseAST } from "../parseAST.js";
import { parseSQLFile } from "../parseSQL.js";
import { parsePythonASTContent } from "../parsePythonAST.js";
import { parseJSONFile } from "../parseJSON.js";
import type { ASTMetadata } from "../parseAST.js";

export function parseFileContent(filePath: string, content: string): ASTMetadata {
    let ast: ASTMetadata;
    if (filePath.endsWith(".ts") || filePath.endsWith(".js") || filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
        ast = parseAST(content);
    } else if (filePath.endsWith(".py")) {
        ast = parsePythonASTContent(content);
    } else if (filePath.endsWith(".sql")) {
        ast = parseSQLFile(content);
    } else if (filePath.endsWith(".json")) {
        ast = parseJSONFile(content);
    } else {
        // Fallback empty AST for unsupported files
        ast = {
            imports: [],
            importSources: [],
            importedSymbols: [],
            callExpressions: [],
            propertyAccessExpressions: [],
            memberExpressions: [],
            catchClauses: [],
            exports: [],
            classDeclarations: [],
            executionBlocks: [], decorators: [], ifStatementCount: 0, loopCount: 0, hasAsyncAwait: false };
    }

    ast.contentHash = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
    return ast;
}
