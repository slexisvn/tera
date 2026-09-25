import { DocumentHighlightKind, type DocumentHighlight, type DocumentHighlightParams, type Range } from "vscode-languageserver/node.js";
import { isFieldSymbolAt, isStringLiteralTextPosition } from "tera/frontend";
import { pathOfUri } from "../analyzer/paths.ts";
import { wordRangeAt } from "../analyzer/position.ts";
import { objectKeyPositionSet, positionKey } from "../analyzer/token-context.ts";
import type { AnalyzedDocument, AnalyzedToken, Position } from "../analyzer/types.ts";
import { isMemberAccess, resolveReceiverType, symbolsFor } from "../language/members.ts";
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
  const objectKeys = objectKeyPositionSet(document.tokens);

  if (!objectKeys.has(positionKey(word.range.start))) {
    const imported = importedHighlights(context, params.textDocument.uri, document, word.text, objectKeys);
    if (imported) return imported;
  }

  const target = definitionSiteAt(context, params.textDocument.uri, document, params.position, word.text, objectKeys, word.range.start);
  if (!target) return [{ range: word.range, kind: DocumentHighlightKind.Text }];

  const highlights: DocumentHighlight[] = [];
  for (const token of document.tokens) {
    if (token.type !== "identifier" || token.value !== word.text) continue;
    const position = tokenStart(token);
    const site = definitionSiteAt(context, params.textDocument.uri, document, position, token.value, objectKeys, position);
    if (site && site.line === target.line && site.column === target.column) {
      highlights.push({ range: tokenRange(token), kind: DocumentHighlightKind.Text });
    }
  }
  return highlights.length ? highlights : [{ range: word.range, kind: DocumentHighlightKind.Text }];
}

function importedHighlights(
  context: ProviderContext,
  uri: string,
  document: AnalyzedDocument,
  word: string,
  objectKeys: ReadonlySet<string>,
): DocumentHighlight[] | null {
  const entryPath = pathOfUri(uri);
  if (entryPath === null) return null;
  const target = context.modules
    .importedNames(entryPath, document.lines)
    .find((name) => name.local === word);
  if (target === undefined) return null;

  const highlights: DocumentHighlight[] = [{
    range: {
      start: { line: target.line, character: target.character },
      end: { line: target.line, character: target.character + word.length },
    },
    kind: DocumentHighlightKind.Write,
  }];
  for (const token of document.tokens) {
    if (token.type !== "identifier" || token.value !== word) continue;
    if (objectKeys.has(positionKey(token))) continue;
    const start = tokenStart(token);
    if (start.line === target.line && start.character === target.character) continue;
    highlights.push({ range: tokenRange(token), kind: DocumentHighlightKind.Read });
  }
  return highlights;
}

function definitionSiteAt(
  context: ProviderContext,
  uri: string,
  document: AnalyzedDocument,
  position: Position,
  word: string,
  objectKeys: ReadonlySet<string>,
  wordStart: Position,
): DefinitionSite | null {
  const symbols = symbolsFor(context, uri, document);
  const local = symbols.resolve(word, position);
  if (objectKeys.has(positionKey(wordStart)) && !isFieldSymbolAt(local, wordStart)) return null;
  if (isMemberAccess(document, position)) {
    const receiverType = resolveReceiverType(context, uri, document, position);
    const field = receiverType ? symbols.resolveField(receiverType, word, position) : null;
    return field && field.line > 0 ? { line: field.line, column: field.column } : null;
  }
  const symbol = local;
  return symbol && symbol.line > 0 ? { line: symbol.line, column: symbol.column } : null;
}

function tokenStart(token: AnalyzedToken): Position {
  return { line: token.line - 1, character: token.column - 1 };
}

function tokenRange(token: AnalyzedToken): Range {
  const start = tokenStart(token);
  return { start, end: { line: start.line, character: start.character + token.value.length } };
}
