import type { ASTMetadata } from './parseAST.js';

export function parseSQLFile(code: string): ASTMetadata {
    
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

    // Very basic SQL heuristics using Regex
    
    // 1. Find table creations or alterations (acting as 'exports' or 'classes')
    const createTableRegex = /CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."]+)/gi;
    let match;
    while ((match = createTableRegex.exec(code)) !== null) {
        const tableName = match[1].replace(/["']/g, '');
        metadata.classDeclarations.push({ name: tableName, line: 1, column: 1 });
        metadata.exports.push({ name: tableName, isDefault: true, kind: 'class', line: 1, column: 1 });
    }

    const alterTableRegex = /ALTER\s+TABLE\s+([a-zA-Z0-9_."]+)/gi;
    while ((match = alterTableRegex.exec(code)) !== null) {
        const tableName = match[1].replace(/["']/g, '');
        // An alter acts as both an export (modifying it) and a dependency
        metadata.exports.push({ name: tableName, isDefault: false, kind: 'class', line: 1, column: 1 });
        metadata.importSources.push({ moduleSpecifier: tableName, line: 1, column: 1 });
    }

    // 2. Find dependencies (tables referenced)
    // Matches FROM table, JOIN table, REFERENCES table
    const refRegex = /(?:FROM|JOIN|REFERENCES)\s+([a-zA-Z0-9_."]+)/gi;
    while ((match = refRegex.exec(code)) !== null) {
        const tableName = match[1].replace(/["']/g, '');
        // Ignore keywords that might falsely match depending on SQL dialect
        if (['SELECT', 'WHERE', 'ON', 'AS', 'AND', 'OR'].includes(tableName.toUpperCase())) continue;
        
        // Add to imports if we don't already have it
        if (!metadata.importSources.some(imp => imp.moduleSpecifier === tableName)) {
            metadata.importSources.push({ moduleSpecifier: tableName, line: 1, column: 1 });
        }
    }

    // 3. Find functions or procedures
    const procRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([a-zA-Z0-9_."]+)/gi;
    while ((match = procRegex.exec(code)) !== null) {
        const funcName = match[1].replace(/["']/g, '');
        metadata.exports.push({ name: funcName, isDefault: false, kind: 'variable', line: 1, column: 1 });
    }

    // 4. Variables/Constants (e.g. SET or DECLARE)
    const varRegex = /(?:SET|DECLARE)\s+([a-zA-Z0-9_@]+)/gi;
    while ((match = varRegex.exec(code)) !== null) {
        const varName = match[1].replace(/["']/g, '');
        // Just treat as an export for tracking
        metadata.exports.push({ name: varName, isDefault: false, kind: 'variable', line: 1, column: 1 });
    }

    return metadata;
}
