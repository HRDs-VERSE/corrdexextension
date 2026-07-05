import type { Position } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";

import type { ASTMetadata, ExecutionBlockMetadata } from "../parseAST.js";

export interface HoveredFileSymbol {
  name: string;
  line: number;
}

export function findHoveredFunctionBlock(
  document: TextDocument,
  position: Position,
  executionBlocks: ExecutionBlockMetadata[],
): ExecutionBlockMetadata | undefined {
  for (const block of executionBlocks) {
    if (!block.name) {
      continue;
    }
    if (isHoveringIdentifier(document, position, block.startLine - 1, block.name)) {
      return block;
    }
  }
  return undefined;
}

export function findHoveredFileSymbol(
  document: TextDocument,
  position: Position,
  ast: ASTMetadata,
): HoveredFileSymbol | undefined {
  const symbol = resolveDominantFileSymbol(ast);
  if (!symbol) {
    return undefined;
  }

  return isHoveringIdentifier(document, position, symbol.line, symbol.name) ? symbol : undefined;
}

function resolveDominantFileSymbol(ast: ASTMetadata): HoveredFileSymbol | undefined {
  const exportedFunction = ast.executionBlocks.find((block) => block.isExported && block.name);
  if (exportedFunction?.name) {
    return {
      name: exportedFunction.name,
      line: exportedFunction.startLine - 1,
    };
  }

  const exportedClass = ast.exports.find((entry) => entry.kind === "class" && entry.name);
  if (exportedClass?.name) {
    return {
      name: exportedClass.name,
      line: exportedClass.line - 1,
    };
  }

  const namedExport = ast.exports.find((entry) => entry.name);
  if (namedExport?.name) {
    return {
      name: namedExport.name,
      line: namedExport.line - 1,
    };
  }

  return undefined;
}

function isHoveringIdentifier(
  document: TextDocument,
  position: Position,
  line: number,
  identifier: string,
): boolean {
  if (position.line !== line) {
    return false;
  }

  const lineText = getLineText(document, line);
  if (!lineText) {
    return false;
  }

  const matchIndex = findIdentifierOccurrence(lineText, identifier);
  if (matchIndex === -1) {
    return false;
  }

  return position.character >= matchIndex && position.character <= matchIndex + identifier.length;
}

function getLineText(document: TextDocument, line: number): string {
  const lines = document.getText().split(/\r?\n/);
  return lines[line] ?? "";
}

function findIdentifierOccurrence(lineText: string, identifier: string): number {
  let startIndex = -1;

  while (true) {
    startIndex = lineText.indexOf(identifier, startIndex + 1);
    if (startIndex === -1) {
      return -1;
    }

    const before = startIndex === 0 ? "" : lineText[startIndex - 1];
    const after = startIndex + identifier.length >= lineText.length ? "" : lineText[startIndex + identifier.length];
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) {
      return startIndex;
    }
  }
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

