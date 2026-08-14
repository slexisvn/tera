import {
  SymbolKind,
  type DocumentSymbol,
  type DocumentSymbolParams,
} from "vscode-languageserver/node.js";
import type { AnalyzedDocument, Scope, TeraSymbol } from "../analyzer/index.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const KIND_BY_SYMBOL: Record<string, SymbolKind> = {
  model: SymbolKind.Class,
  module: SymbolKind.Class,
  function: SymbolKind.Function,
  method: SymbolKind.Method,
  property: SymbolKind.Property,
  field: SymbolKind.Field,
  parameter: SymbolKind.Variable,
  variable: SymbolKind.Variable,
};

export default defineProvider({
  id: "documentSymbols",
  register(connection, context) {
    connection.onDocumentSymbol((params): DocumentSymbol[] => {
      try {
        return computeDocumentSymbols(context, params);
      } catch (error) {
        connection.console.error(`documentSymbol error: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
  },
});

export function computeDocumentSymbols(
  context: ProviderContext,
  params: DocumentSymbolParams,
): DocumentSymbol[] {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document) return [];
  return outline(document.symbols.root, document);
}

function outline(scope: Scope | null, document: AnalyzedDocument): DocumentSymbol[] {
  if (scope === null) return [];
  const symbols: DocumentSymbol[] = [];
  for (const symbol of scope.symbols) {
    if (symbol.kind === "parameter" || symbol.line <= 0) continue;
    symbols.push(toDocumentSymbol(symbol, document));
  }
  return symbols;
}

function toDocumentSymbol(symbol: TeraSymbol, document: AnalyzedDocument): DocumentSymbol {
  const start = { line: symbol.line - 1, character: symbol.column - 1 };
  const selection = {
    start,
    end: { line: start.line, character: start.character + symbol.name.length },
  };
  const children = outline(symbol.scope ?? null, document);
  const end = children.length === 0 ? selection.end : children[children.length - 1]!.range.end;
  return {
    name: symbol.name,
    detail: symbol.typeName ?? undefined,
    kind: KIND_BY_SYMBOL[symbol.kind] ?? SymbolKind.Variable,
    range: { start, end },
    selectionRange: selection,
    children: children.length === 0 ? undefined : children,
  };
}
