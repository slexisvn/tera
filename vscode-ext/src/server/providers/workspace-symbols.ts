import {
  SymbolKind,
  type SymbolInformation,
  type WorkspaceSymbolParams,
} from "vscode-languageserver/node.js";
import type { ModuleBindingKind } from "tera/frontend";
import { moduleLabel } from "../analyzer/modules.ts";
import { pathOfUri } from "../analyzer/paths.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const KIND_BY_BINDING: Record<ModuleBindingKind, SymbolKind> = {
  function: SymbolKind.Function,
  class: SymbolKind.Class,
  model: SymbolKind.Class,
  interface: SymbolKind.Interface,
  type: SymbolKind.TypeParameter,
  value: SymbolKind.Variable,
  module: SymbolKind.Module,
};

const RESULT_LIMIT = 256;

export default defineProvider({
  id: "workspaceSymbols",
  register(connection, context) {
    connection.onWorkspaceSymbol((params): SymbolInformation[] => {
      try {
        return computeWorkspaceSymbols(context, params);
      } catch (error) {
        connection.console.error(`workspaceSymbol error: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
  },
});

export function computeWorkspaceSymbols(
  context: ProviderContext,
  params: WorkspaceSymbolParams,
): SymbolInformation[] {
  const entryPath = anchorPath(context);
  if (entryPath === null) return [];

  const query = params.query.toLowerCase();
  const symbols: SymbolInformation[] = [];
  for (const filePath of context.modules.moduleFiles(entryPath)) {
    if (symbols.length >= RESULT_LIMIT) break;
    for (const binding of context.modules.declaredNamesOf(filePath)) {
      if (query.length > 0 && !binding.name.toLowerCase().includes(query)) continue;
      symbols.push({
        name: binding.name,
        kind: KIND_BY_BINDING[binding.kind],
        containerName: moduleLabel(context.modules.specOf(entryPath, filePath) ?? filePath),
        location: {
          uri: context.modules.uriFor(filePath),
          range: {
            start: { line: binding.span.line - 1, character: binding.span.column - 1 },
            end: { line: binding.span.line - 1, character: binding.span.column - 1 + binding.name.length },
          },
        },
      });
      if (symbols.length >= RESULT_LIMIT) break;
    }
  }
  return symbols;
}

function anchorPath(context: ProviderContext): string | null {
  for (const uri of context.analyzer.uris()) {
    const filePath = pathOfUri(uri);
    if (filePath !== null) return filePath;
  }
  return null;
}
