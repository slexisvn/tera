import type { Position } from "vscode-languageserver/node.js";
import type { ModuleGraph } from "tera/frontend";
import { importCursorAt } from "../analyzer/import-syntax.ts";
import { importOwning, namespaceImport, resolveExport } from "../analyzer/modules.ts";
import { pathOfUri, samePath } from "../analyzer/paths.ts";
import { receiverNameAt } from "../analyzer/position.ts";
import type { AnalyzedDocument } from "../analyzer/types.ts";
import type { ProviderContext } from "./types.ts";

export type ModuleSymbol = {
  readonly entryPath: string;
  readonly ownerPath: string;
  readonly name: string;
  readonly declaration: { line: number; character: number } | null;
};

export function moduleSymbolAt(
  context: ProviderContext,
  uri: string,
  document: AnalyzedDocument,
  position: Position,
  word: string,
): ModuleSymbol | null {
  const entryPath = pathOfUri(uri);
  const graph = context.modules.graphFor(uri);
  if (entryPath === null || graph === null) return null;

  const cursor = importCursorAt(document.lines, position);
  if (cursor !== null) {
    if (cursor.kind === "path" || cursor.kind === "alias") return null;
    const segments = cursor.syntax.path.map((token) => token.text);
    const { resolver, from } = context.modules.resolverFor(entryPath);
    const resolved = resolver.tryResolve({ level: cursor.syntax.level, path: segments }, from);
    if (resolved?.path == null) return null;
    const spec = specOf(graph, resolved.path);
    return owned(entryPath, graph, spec, cursor.specifier.imported.text, resolved.path);
  }

  const receiver = receiverNameAt(document.lines, position);
  if (receiver !== null) {
    const entry = namespaceImport(graph.entry, receiver);
    if (entry === null) return null;
    return owned(entryPath, graph, entry.boundSpec ?? entry.module, word, null);
  }

  const origin = importOwning(graph.entry, word);
  if (origin !== null) {
    if (origin.namespace) return null;
    return owned(entryPath, graph, origin.spec, origin.imported, null);
  }

  const binding = graph.entry.bindings.get(word);
  if (binding === undefined || graph.entry.path === null) return null;
  return {
    entryPath,
    ownerPath: graph.entry.path,
    name: word,
    declaration: { line: binding.span.line - 1, character: binding.span.column - 1 },
  };
}

function owned(
  entryPath: string,
  graph: ModuleGraph,
  spec: string | null,
  name: string,
  fallback: string | null,
): ModuleSymbol | null {
  const target = spec === null ? null : resolveExport(graph, spec, name);
  if (target !== null && target.path !== null && target.kind !== "module") {
    return {
      entryPath,
      ownerPath: target.path,
      name: target.name,
      declaration: { line: target.line - 1, character: target.column - 1 },
    };
  }
  return fallback === null ? null : { entryPath, ownerPath: fallback, name, declaration: null };
}

function specOf(graph: ModuleGraph, filePath: string): string | null {
  for (const [spec, record] of graph.modules) {
    if (record.path !== null && samePath(record.path, filePath)) return spec;
  }
  return null;
}
