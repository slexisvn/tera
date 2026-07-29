import type { DefinitionParams, Location } from "vscode-languageserver/node.js";
import { isStringLiteralTextPosition } from "../../../../src/frontend/index.ts";
import { wordRangeAt } from "../analyzer/position.ts";
import type { AnalyzedDocument, AnalyzedToken } from "../analyzer/types.ts";
import { isMemberAccess, resolveReceiverType } from "../language/members.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

export default defineProvider({
  id: "definition",
  register(connection, context) {
    connection.onDefinition((params): Location | null => {
      try {
        return computeDefinition(context, params);
      } catch (error) {
        connection.console.error(`definition error: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
  },
});

export function computeDefinition(context: ProviderContext, params: DefinitionParams): Location | null {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document) return null;
  if (isStringLiteralTextPosition(document.text, params.position)) return null;

  const word = wordRangeAt(document.lines, params.position);
  if (!word) return null;
  if (isObjectKey(document, word.range.start)) return null;

  const superTarget = superDefinition(context, document, params, word);
  if (superTarget) return superTarget;

  if (isMemberAccess(document, params.position)) {
    const receiverType = resolveReceiverType(context, document, params.position);
    if (!receiverType) return null;
    const field = document.symbols.resolveField(receiverType, word.text, params.position);
    return field && field.line > 0 ? location(params.textDocument.uri, field.name, field.line, field.column) : null;
  }

  const symbol = document.symbols.resolve(word.text, params.position);
  return symbol ? location(params.textDocument.uri, symbol.name, symbol.line, symbol.column) : null;
}

function superDefinition(
  context: ProviderContext,
  document: AnalyzedDocument,
  params: DefinitionParams,
  word: NonNullable<ReturnType<typeof wordRangeAt>>,
): Location | null {
  if (word.text !== "super") return null;
  const line = document.lines[word.range.start.line] ?? "";
  const member = memberAfterDot(line, word.range.end.character);
  if (member) {
    const position = { line: word.range.start.line, character: member.end };
    const receiverType = resolveReceiverType(context, document, position);
    const field = receiverType ? document.symbols.resolveField(receiverType, member.name, position) : null;
    return field && field.line > 0 ? location(params.textDocument.uri, field.name, field.line, field.column) : null;
  }
  const symbol = document.symbols.resolve("super", params.position);
  const owner = symbol?.typeName ? typeSymbol(document, symbol.typeName) : null;
  const constructor = owner?.scope?.symbols.find((item) => item.name === "constructor");
  const target = constructor ?? owner;
  return target ? location(params.textDocument.uri, target.name, target.line, target.column) : null;
}

function memberAfterDot(line: string, start: number): { name: string; end: number } | null {
  let cursor = start;
  while (cursor < line.length && /\s/.test(line[cursor])) cursor++;
  if (line[cursor] !== ".") return null;
  cursor++;
  while (cursor < line.length && /\s/.test(line[cursor])) cursor++;
  const match = line.slice(cursor).match(/^[A-Za-z_$][\w$]*/);
  return match ? { name: match[0], end: cursor + match[0].length } : null;
}

function typeSymbol(document: AnalyzedDocument, typeName: string) {
  return document.symbols.flat.find((symbol) => symbol.name === typeName && (symbol.kind === "module" || symbol.kind === "model")) ?? null;
}

function isObjectKey(document: AnalyzedDocument, position: { line: number; character: number }): boolean {
  const tokens = document.tokens;
  const index = tokens.findIndex((token) => token.line === position.line + 1 && token.column === position.character + 1);
  if (index < 0 || tokens[index].type !== "identifier") return false;
  const next = nextAfterOptional(tokens, index + 1, "?");
  if (tokens[next]?.value !== ":") return false;
  return enclosingBrace(tokens, index)?.value === "{";
}

function nextAfterOptional(tokens: AnalyzedToken[], index: number, optional: string): number {
  return tokens[index]?.value === optional ? index + 1 : index;
}

function enclosingBrace(tokens: AnalyzedToken[], before: number): AnalyzedToken | null {
  const stack: AnalyzedToken[] = [];
  for (let i = 0; i < before; i++) {
    const value = tokens[i].value;
    if (value === "{" || value === "[" || value === "(") stack.push(tokens[i]);
    else if (value === "}" || value === "]" || value === ")") stack.pop();
  }
  return stack.at(-1) ?? null;
}

function location(uri: string, name: string, lineOneBased: number, columnOneBased: number): Location {
  const line = Math.max(0, lineOneBased - 1);
  const character = Math.max(0, columnOneBased - 1);
  return {
    uri,
    range: {
      start: { line, character },
      end: { line, character: character + name.length },
    },
  };
}

