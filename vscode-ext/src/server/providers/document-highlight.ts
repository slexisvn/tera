import { DocumentHighlightKind, type DocumentHighlight, type DocumentHighlightParams, type Range } from "vscode-languageserver/node.js";
import { isStringLiteralTextPosition } from "../../../../src/frontend/index.ts";
import { wordRangeAt } from "../analyzer/position.ts";
import type { AnalyzedDocument, AnalyzedToken, Position } from "../analyzer/types.ts";
import { isMemberAccess, resolveReceiverType } from "../language/members.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

type DefinitionSite = { line: number; column: number };

export default defineProvider({
  id: "documentHighlight",
  register(connection, context) {
    connection.onDocumentHighlight((params): DocumentHighlight[] | null => {
      try {
        return computeHighlights(context, params);
      } catch (error) {
        connection.console.error(`documentHighlight error: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
  },
});

export function computeHighlights(context: ProviderContext, params: DocumentHighlightParams): DocumentHighlight[] | null {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document) return null;
  if (isStringLiteralTextPosition(document.text, params.position)) return null;

  const word = wordRangeAt(document.lines, params.position);
  if (!word) return null;

  const target = definitionSiteAt(context, document, params.position, word.text);
  if (!target) return [{ range: word.range, kind: DocumentHighlightKind.Text }];

  const highlights: DocumentHighlight[] = [];
  for (const token of document.tokens) {
    if (token.type !== "identifier" || token.value !== word.text) continue;
    const position = tokenStart(token);
    const site = definitionSiteAt(context, document, position, token.value);
    if (site && site.line === target.line && site.column === target.column) {
      highlights.push({ range: tokenRange(token), kind: DocumentHighlightKind.Text });
    }
  }
  return highlights.length ? highlights : [{ range: word.range, kind: DocumentHighlightKind.Text }];
}

function definitionSiteAt(context: ProviderContext, document: AnalyzedDocument, position: Position, word: string): DefinitionSite | null {
  if (isMemberAccess(document, position)) {
    const receiverType = resolveReceiverType(context, document, position);
    const field = receiverType ? document.symbols.resolveField(receiverType, word, position) : null;
    return field && field.line > 0 ? { line: field.line, column: field.column } : null;
  }
  const symbol = document.symbols.resolve(word, position);
  return symbol && symbol.line > 0 ? { line: symbol.line, column: symbol.column } : null;
}

function tokenStart(token: AnalyzedToken): Position {
  return { line: token.line - 1, character: token.column - 1 };
}

function tokenRange(token: AnalyzedToken): Range {
  const start = tokenStart(token);
  return { start, end: { line: start.line, character: start.character + token.value.length } };
}
