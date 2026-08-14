import type { DefinitionParams, Location } from "vscode-languageserver/node.js";
import { isStringLiteralTextPosition, type ModuleGraph } from "tera/frontend";
import { importCursorAt } from "../analyzer/import-syntax.ts";
import {
  importOwning,
  moduleTarget,
  namespaceImport,
  resolveExport,
  type ModuleTarget,
} from "../analyzer/modules.ts";
import { pathOfUri, samePath } from "../analyzer/paths.ts";
import { receiverNameAt, wordRangeAt } from "../analyzer/position.ts";
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

  const imported = importDefinition(context, document, params);
  if (imported) return imported;

  const word = wordRangeAt(document.lines, params.position);
  if (!word) return null;
  if (isObjectKey(document, word.range.start)) return null;

  const crossModule = crossModuleDefinition(context, document, params, word.text);
  if (crossModule) return crossModule;

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

function importDefinition(
  context: ProviderContext,
  document: AnalyzedDocument,
  params: DefinitionParams,
): Location | null {
  const cursor = importCursorAt(document.lines, params.position);
  if (cursor === null) return null;
  const uri = params.textDocument.uri;

  if (cursor.kind === "path") {
    const segments = cursor.syntax.path.slice(0, cursor.index + 1).map((token) => token.text);
    return moduleFileLocation(context, uri, cursor.syntax.level, segments);
  }
  if (cursor.kind === "alias") {
    const segments = cursor.syntax.path.map((token) => token.text);
    return moduleFileLocation(context, uri, cursor.syntax.level, segments);
  }

  const segments = cursor.syntax.path.map((token) => token.text);
  const owner = resolvedModulePath(context, uri, cursor.syntax.level, segments);
  if (owner === null) return null;
  const graph = context.modules.graphFor(uri);
  const spec = graph === null ? null : specOfPath(graph, owner);
  if (graph === null || spec === null) return fileLocation(context, owner);
  const target = resolveExport(graph, spec, cursor.specifier.imported.text);
  return target === null ? fileLocation(context, owner) : targetLocation(context, target);
}

function crossModuleDefinition(
  context: ProviderContext,
  document: AnalyzedDocument,
  params: DefinitionParams,
  word: string,
): Location | null {
  const graph = context.modules.graphFor(params.textDocument.uri);
  if (graph === null) return null;

  const receiver = receiverNameAt(document.lines, params.position);
  if (receiver !== null) {
    const entry = namespaceImport(graph.entry, receiver);
    if (entry === null) return null;
    const target = resolveExport(graph, entry.boundSpec ?? entry.module, word);
    return target === null ? null : targetLocation(context, target);
  }

  const origin = importOwning(graph.entry, word);
  if (origin === null) return null;
  const target = origin.namespace
    ? moduleTarget(graph, origin.spec)
    : resolveExport(graph, origin.spec, origin.imported);
  return target === null ? null : targetLocation(context, target);
}

function resolvedModulePath(
  context: ProviderContext,
  uri: string,
  level: number,
  segments: readonly string[],
): string | null {
  const entryPath = pathOfUri(uri);
  if (entryPath === null) return null;
  const { resolver, from } = context.modules.resolverFor(entryPath);
  const resolved = resolver.tryResolve({ level, path: [...segments] }, from);
  if (resolved === null || resolved.path === null || resolved.kind === "namespace") return null;
  return resolved.path;
}

function moduleFileLocation(
  context: ProviderContext,
  uri: string,
  level: number,
  segments: readonly string[],
): Location | null {
  const resolved = resolvedModulePath(context, uri, level, segments);
  return resolved === null ? null : fileLocation(context, resolved);
}

function specOfPath(graph: ModuleGraph, filePath: string): string | null {
  for (const [spec, record] of graph.modules) {
    if (record.path !== null && samePath(record.path, filePath)) return spec;
  }
  return null;
}

function targetLocation(context: ProviderContext, target: ModuleTarget): Location | null {
  if (target.path === null) return null;
  if (target.kind === "module") return fileLocation(context, target.path);
  return location(context.modules.uriFor(target.path), target.name, target.line, target.column);
}

function fileLocation(context: ProviderContext, filePath: string): Location {
  return {
    uri: context.modules.uriFor(filePath),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  };
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

