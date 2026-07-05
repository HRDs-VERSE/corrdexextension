import ts from 'typescript';
import type { ASTMetadata, CallExpressionMetadata, CatchClauseMetadata, ClassDeclarationMetadata, DecoratorMetadata, ExecutionBlockMetadata, ExportKind, ExportMetadata, ImportMetadata, ImportSourceMetadata, ImportedSymbolMetadata, MemberExpressionMetadata, PropertyAccessMetadata, SemanticContext } from '@corrdex/shared/ast.js';
export type { ASTMetadata, CallExpressionMetadata, CatchClauseMetadata, ClassDeclarationMetadata, DecoratorMetadata, ExecutionBlockMetadata, ExportKind, ExportMetadata, ImportMetadata, ImportSourceMetadata, ImportedSymbolMetadata, MemberExpressionMetadata, PropertyAccessMetadata } from '@corrdex/shared/ast.js';

function getCleanExpressionPath(node: ts.Expression, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return `${getCleanExpressionPath(node.expression, sourceFile)}.${node.name.text}`;
  }
  if (ts.isCallExpression(node)) {
    return getCleanExpressionPath(node.expression, sourceFile);
  }
  if (ts.isNewExpression(node)) {
    return `new ${getCleanExpressionPath(node.expression, sourceFile)}`;
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return "this";
  }
  if (node.kind === ts.SyntaxKind.SuperKeyword) {
    return "super";
  }
  return node.getText(sourceFile).replace(/\s+/g, " ");
}

/**
 * Parses TypeScript source code into an AST and extracts specific metadata.
 * 
 * @param content The TypeScript source code as a string
 * @returns Structured metadata containing found imports and call expressions
 */
export function parseAST(content: string): ASTMetadata {
  // Create a SourceFile object representing the parsed AST
  const sourceFile = ts.createSourceFile(
    'anonymous.ts',
    content,
    ts.ScriptTarget.Latest,
    true // setParentNodes
  );

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
    hasAsyncAwait: false,
  };

  const astPrinter = ts.createPrinter({ removeComments: true });

  let functionCounter = 0;
  const blockStack: string[] = [];
  const classStack: Array<{ name?: string; startLine: number; endLine: number }> = [];

  function normalizeStableSegment(value: string): string {
    return value
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  }

  function buildStableExecutionBlockId(
    kind: ExecutionBlockMetadata["kind"],
    name: string | undefined,
    enclosingClassName: string | undefined,
    startLine: number,
    endLine: number,
  ): string {
    const parts: string[] = [kind];
    const normalizedClassName = enclosingClassName ? normalizeStableSegment(enclosingClassName) : "";
    const normalizedName = name ? normalizeStableSegment(name) : "";

    if (normalizedClassName) {
      parts.push(`class-${normalizedClassName}`);
    }

    if (normalizedName) {
      parts.push(`name-${normalizedName}`);
    } else {
      parts.push(`lines-${startLine}-${endLine}`);
    }

    const baseId = parts.join(":");
    let candidate = baseId;
    let duplicateCount = 2;

    while (metadata.executionBlocks.some((block) => block.stableId === candidate)) {
      candidate = `${baseId}#${duplicateCount++}`;
    }

    return candidate;
  }

  function getCurrentExecutionBlock(): ExecutionBlockMetadata | undefined {
    const currentBlockId = blockStack[blockStack.length - 1];
    if (!currentBlockId) return undefined;
    return metadata.executionBlocks.find((block) => block.id === currentBlockId);
  }

  function getParameterNames(node: ts.SignatureDeclarationBase): string[] {
    return node.parameters
      .map((parameter) => parameter.name.getText(sourceFile).trim())
      .filter(Boolean);
  }

  function isAsyncFunctionLike(node: ts.FunctionLikeDeclarationBase): boolean {
    return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  }

  function isExportedVariableDeclaration(node: ts.VariableDeclaration): boolean {
    return ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent) &&
      hasExportModifier(node.parent.parent);
  }

  function isFunctionLikeExpression(
    expression: ts.Expression
  ): expression is ts.ArrowFunction | ts.FunctionExpression {
    return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
  }

  function unwrapFunctionLikeFromExpression(
    expression: ts.Expression | undefined,
    visited = new Set<ts.Node>()
  ): ts.ArrowFunction | ts.FunctionExpression | undefined {
    if (!expression || visited.has(expression)) {
      return undefined;
    }

    visited.add(expression);

    if (isFunctionLikeExpression(expression)) {
      return expression;
    }

    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return unwrapFunctionLikeFromExpression(expression.expression, visited);
    }

    if (ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) {
      return unwrapFunctionLikeFromExpression(expression.expression, visited);
    }

    if (ts.isCallExpression(expression)) {
      for (const argument of expression.arguments) {
        const unwrappedArgument = unwrapFunctionLikeFromExpression(argument, visited);
        if (unwrappedArgument) {
          return unwrappedArgument;
        }
      }
    }

    return undefined;
  }

  /**
   * Recursively traverses the AST nodes.
   */
  function visit(node: ts.Node) {
    // 1. Detect Imported modules (ImportDeclarations)
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : node.moduleSpecifier.getText(sourceFile);

      let defaultImport: string | undefined;
      const namedImports: string[] = [];

      if (node.importClause) {
        // Default import e.g., import ts from 'typescript'
        if (node.importClause.name) {
          defaultImport = node.importClause.name.text;
        }

        // Named imports or Namespace imports e.g., import { a, b } or import * as c
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            node.importClause.namedBindings.elements.forEach((element) => {
              namedImports.push(element.name.text);
            });
          } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            namedImports.push(`* as ${node.importClause.namedBindings.name.text}`);
          }
        }
      }

      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
      );

      metadata.imports.push({
        moduleSpecifier,
        ...(defaultImport ? { defaultImport } : {}),
        ...(namedImports.length > 0 ? { namedImports } : {}),
        isTypeOnly: node.importClause?.isTypeOnly ?? false,
        line: line + 1,
        column: character + 1,
      });

      metadata.importSources.push({
        moduleSpecifier,
        isTypeOnly: node.importClause?.isTypeOnly ?? false,
        line: line + 1,
        column: character + 1,
      });

      if (defaultImport) {
        metadata.importedSymbols.push({
          importedName: "default",
          localName: defaultImport,
          moduleSpecifier,
          isDefault: true,
          isNamespace: false,
          isTypeOnly: node.importClause?.isTypeOnly ?? false,
          line: line + 1,
          column: character + 1,
        });
      }

      if (node.importClause?.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          node.importClause.namedBindings.elements.forEach((element) => {
            metadata.importedSymbols.push({
              importedName: element.propertyName?.text ?? element.name.text,
              localName: element.name.text,
              moduleSpecifier,
              isDefault: false,
              isNamespace: false,
              isTypeOnly: element.isTypeOnly || node.importClause?.isTypeOnly || false,
              line: line + 1,
              column: character + 1,
            });
          });
        } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          metadata.importedSymbols.push({
            importedName: "*",
            localName: node.importClause.namedBindings.name.text,
            moduleSpecifier,
            isDefault: false,
            isNamespace: true,
            isTypeOnly: node.importClause?.isTypeOnly ?? false,
            line: line + 1,
            column: character + 1,
          });
        }
      }
    }

    // 2. Detect CallExpressions and NewExpressions
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const isNew = ts.isNewExpression(node);
      const expression = (isNew ? "new " : "") + getCleanExpressionPath(node.expression, sourceFile);
      const args = node.arguments ? node.arguments.map((arg) => astPrinter.printNode(ts.EmitHint.Unspecified, arg, sourceFile)) : [];
      
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
      );

      metadata.callExpressions.push({
        expression,
        arguments: args,
        context: inferSemanticContext(node),
        line: line + 1,    // 1-indexed for better readability
        column: character + 1,
        blockId: blockStack[blockStack.length - 1],
      });
    }

    if (ts.isPropertyAccessExpression(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
      );

      metadata.propertyAccessExpressions.push({
        expression: getCleanExpressionPath(node, sourceFile),
        context: inferSemanticContext(node),
        line: line + 1,
        column: character + 1,
        blockId: blockStack[blockStack.length - 1],
      });

      metadata.memberExpressions.push({
        object: getCleanExpressionPath(node.expression, sourceFile),
        property: node.name.getText(sourceFile),
        expression: getCleanExpressionPath(node, sourceFile),
        usage: getMemberExpressionUsage(node),
        context: inferSemanticContext(node),
        line: line + 1,
        column: character + 1,
        blockId: blockStack[blockStack.length - 1],
      });
    }

    let pushedBlockId: string | undefined;
    let pushedClass = false;

    if (ts.isFunctionDeclaration(node)) {
      const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const enclosingClassName = classStack[classStack.length - 1]?.name;
      pushedBlockId = `fn_${++functionCounter}`;
      metadata.executionBlocks.push({
        id: pushedBlockId,
        stableId: buildStableExecutionBlockId("function", node.name?.text, enclosingClassName, startLine + 1, endLine + 1),
        name: node.name?.text,
        kind: "function",
        startLine: startLine + 1,
        endLine: endLine + 1,
        dependencies: [],
        identifiers: [],
        parameterNames: getParameterNames(node),
        ifStatementCount: 0,
        loopCount: 0,
        hasAsyncAwait: isAsyncFunctionLike(node),
        isExported: hasExportModifier(node),
        enclosingClassName,
      });

      if (hasExportModifier(node)) {
        metadata.exports.push(
          createExportMetadata(
            node.name?.text,
            "function",
            hasDefaultModifier(node),
            node,
            sourceFile
          )
        );
      }
    }

    if (ts.isMethodDeclaration(node)) {
      const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const enclosingClassName = classStack[classStack.length - 1]?.name;
      let name: string | undefined;
      if (ts.isIdentifier(node.name)) {
        name = node.name.text;
      }
      pushedBlockId = `fn_${++functionCounter}`;
      metadata.executionBlocks.push({
        id: pushedBlockId,
        stableId: buildStableExecutionBlockId("method", name, enclosingClassName, startLine + 1, endLine + 1),
        name,
        kind: "method",
        startLine: startLine + 1,
        endLine: endLine + 1,
        dependencies: [],
        identifiers: [],
        parameterNames: getParameterNames(node),
        ifStatementCount: 0,
        loopCount: 0,
        hasAsyncAwait: isAsyncFunctionLike(node),
        isExported: false,
        enclosingClassName,
      });
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const functionInitializer = unwrapFunctionLikeFromExpression(node.initializer);
      if (!functionInitializer) {
        // Continue traversal so nested callbacks still contribute call/member metadata normally.
      } else {
      const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const enclosingClassName = classStack[classStack.length - 1]?.name;
      let name: string | undefined;
      if (ts.isIdentifier(node.name)) {
        name = node.name.text;
      }
      pushedBlockId = `fn_${++functionCounter}`;
      metadata.executionBlocks.push({
        id: pushedBlockId,
        stableId: buildStableExecutionBlockId("arrow-function", name, enclosingClassName, startLine + 1, endLine + 1),
        name,
        kind: "arrow-function",
        startLine: startLine + 1,
        endLine: endLine + 1,
        dependencies: [],
        identifiers: [],
        parameterNames: getParameterNames(functionInitializer),
        ifStatementCount: 0,
        loopCount: 0,
        hasAsyncAwait: isAsyncFunctionLike(functionInitializer),
        isExported: isExportedVariableDeclaration(node),
        enclosingClassName,
      });
      }
    }

    if (pushedBlockId) {
      blockStack.push(pushedBlockId);
    }

    if (ts.isClassDeclaration(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      let superClass: string | undefined;
      
      if (node.heritageClauses) {
        const extendsClause = node.heritageClauses.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
        if (extendsClause && extendsClause.types.length > 0) {
          superClass = extendsClause.types[0].expression.getText(sourceFile);
        }
      }

      metadata.classDeclarations.push({
        name: node.name?.text,
        superClass,
        line: line + 1,
        column: character + 1,
        startLine: line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      });
      classStack.push({
        name: node.name?.text,
        startLine: line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      });
      pushedClass = true;

      if (hasExportModifier(node)) {
        metadata.exports.push(
          createExportMetadata(
            node.name?.text,
            "class",
            hasDefaultModifier(node),
            node,
            sourceFile
          )
        );
      }
    }

    if (ts.isInterfaceDeclaration(node) && hasExportModifier(node)) {
      metadata.exports.push(
        createExportMetadata(
          node.name.text,
          "interface",
          hasDefaultModifier(node),
          node,
          sourceFile
        )
      );
    }

    if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node)) {
      metadata.exports.push(
        createExportMetadata(
          node.name.text,
          "type-alias",
          hasDefaultModifier(node),
          node,
          sourceFile
        )
      );
    }

    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        const kind = declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)
          ? "object-literal"
          : "variable";

        metadata.exports.push(
          createExportMetadata(
            ts.isIdentifier(declaration.name) ? declaration.name.text : undefined,
            kind,
            hasDefaultModifier(node),
            declaration,
            sourceFile
          )
        );
      }
    }

    if (ts.isExportAssignment(node)) {
      metadata.exports.push(
        createExportMetadata(
          undefined,
          "default-expression",
          true,
          node,
          sourceFile
        )
      );
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        metadata.exports.push(
          createExportMetadata(
            element.name.text,
            "named-reexport",
            false,
            element,
            sourceFile
          )
        );
      }
    }

    if (ts.isCatchClause(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
      );

      metadata.catchClauses.push({
        line: line + 1,
        column: character + 1,
        blockId: blockStack[blockStack.length - 1],
      });
    }

    if (ts.isDecorator(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const startLine = line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const expression = node.expression.getText(sourceFile);
      metadata.decorators.push(expression);
      metadata.decoratorEntries?.push({
        expression,
        line: startLine,
        column: character + 1,
        startLine,
        endLine,
        blockId: blockStack[blockStack.length - 1],
        enclosingClassName: classStack[classStack.length - 1]?.name,
      });
    }

    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      metadata.ifStatementCount++;
      const currentBlock = getCurrentExecutionBlock();
      if (currentBlock) {
        currentBlock.ifStatementCount++;
      }
    }

    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      metadata.loopCount++;
      const currentBlock = getCurrentExecutionBlock();
      if (currentBlock) {
        currentBlock.loopCount++;
      }
    }

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        metadata.hasAsyncAwait = true;
        const currentBlock = getCurrentExecutionBlock();
        if (currentBlock) {
          currentBlock.hasAsyncAwait = true;
        }
      }
    }

    if (ts.isAwaitExpression(node)) {
      metadata.hasAsyncAwait = true;
      const currentBlock = getCurrentExecutionBlock();
      if (currentBlock) {
        currentBlock.hasAsyncAwait = true;
      }
    }

    if (ts.isIdentifier(node) && pushedBlockId === undefined && blockStack.length > 0) {
      const currentBlockId = blockStack[blockStack.length - 1];
      const currentBlock = metadata.executionBlocks.find(b => b.id === currentBlockId);
      if (currentBlock && !currentBlock.identifiers.includes(node.text)) {
        currentBlock.identifiers.push(node.text);
      }
    }

    // Continue traversing the children of the current node
    ts.forEachChild(node, visit);

    if (pushedBlockId) {
      blockStack.pop();
    }
    if (pushedClass) {
      classStack.pop();
    }
  }

  // Start the traversal from the root
  visit(sourceFile);

  // Post-process to collect dependencies for execution blocks
  for (const block of metadata.executionBlocks) {
    const deps = new Set<string>();
    
    // Check call expressions that belong to this block
    for (const call of metadata.callExpressions) {
      if (call.blockId === block.id) {
        deps.add(call.expression.split('.')[0]); // Get the root object being called
      }
    }
    
    // Check member expressions that belong to this block
    for (const member of metadata.memberExpressions) {
      if (member.blockId === block.id) {
        deps.add(member.object.split('.')[0]); // Get the root object accessed
      }
    }
    
    block.dependencies = Array.from(deps).filter(d => 
      d && d !== 'this' && d !== 'super' && !d.includes('(') && !d.includes(' ') && !d.startsWith('new ')
    );
  }

  return metadata;
}

function getMemberExpressionUsage(node: ts.PropertyAccessExpression): "call-target" | "argument" | "reference" {
  if (ts.isCallExpression(node.parent)) {
    if (node.parent.expression === node) {
      return "call-target";
    }

    if (node.parent.arguments.some((argument) => argument === node)) {
      return "argument";
    }
  }

  return "reference";
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefaultModifier(node: ts.HasModifiers): boolean {
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function createExportMetadata(
  name: string | undefined,
  kind: ExportKind,
  isDefault: boolean,
  node: ts.Node,
  sourceFile: ts.SourceFile
): ExportMetadata {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

  return {
    kind,
    name,
    isDefault,
    line: line + 1,
    column: character + 1,
  };
}

function inferSemanticContext(node: ts.Node): SemanticContext {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCallExpression(current)) {
      const exprText = current.expression.getText();
      if (exprText === 'expect' || exprText === 'describe' || exprText === 'it' || exprText === 'test') {
        return "test-reference";
      }
    }
    if (ts.isTypeOfExpression(current)) {
      return "reflection";
    }
    if (ts.isTypeQueryNode(current) || ts.isTypeReferenceNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current) || ts.isTypeLiteralNode(current) || ts.isTypeAssertionExpression(current) || ts.isAsExpression(current)) {
      return "type-only";
    }
    current = current.parent;
  }
  return "runtime-execution";
}

