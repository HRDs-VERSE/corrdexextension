import type { ASTMetadata } from './parseAST.js';

export function parseJSONFile(code: string): ASTMetadata {
    const metadata: ASTMetadata = {
        imports: [],
        importSources: [],
        importedSymbols: [],
        callExpressions: [],
        propertyAccessExpressions: [],
        memberExpressions: [],
        catchClauses: [],
        exports: [],
        executionBlocks: [],
        classDeclarations: [],
        decorators: [],
        decoratorEntries: [],
        ifStatementCount: 0,
        loopCount: 0,
        hasAsyncAwait: false
    };

    return metadata;
}
