import { createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import { buildSourceSymbolTable, inferSymbolTypes, isMemberAccessSource, recoverMemberCompletionSource, resolveMemberReceiverType, type SourceSymbolTable } from "tera/frontend";
import type { AnalyzedDocument, Position } from "../analyzer/index.ts";
import type { ProviderContext } from "../providers/types.ts";

type SymbolCache = {
  uri: string;
  text: string;
  surfaceKey: string;
  symbols: SourceSymbolTable;
};

const symbolCache = new WeakMap<AnalyzedDocument, SymbolCache>();

export function isMemberAccess(document: AnalyzedDocument, position: Position): boolean {
  return isMemberAccessSource(document.text, position);
}

export function symbolsFor(context: ProviderContext, uri: string, document: AnalyzedDocument): SourceSymbolTable {
  const imports = context.modules.importedSurfaceFor(uri, document.lines);
  if (imports === null || surfaceIsEmpty(imports)) return document.symbols;
  const surfaceKey = JSON.stringify(imports);
  const cached = symbolCache.get(document);
  if (cached?.uri === uri && cached.text === document.text && cached.surfaceKey === surfaceKey) return cached.symbols;

  const options = createReactiveCheckOptions();
  const source = recoverMemberCompletionSource(document.text);
  const symbols = buildSourceSymbolTable(source, inferSafely(source, imports), {
    syntaxPlugins: options.syntaxPlugins,
    imports,
  });
  symbolCache.set(document, { uri, text: document.text, surfaceKey, symbols });
  return symbols;
}

export function resolveReceiverType(context: ProviderContext, uri: string, document: AnalyzedDocument, position: Position): string | null {
  return resolveMemberReceiverType(document.text, position, symbolsFor(context, uri, document), context.languageData.globalNamespaces);
}

function inferSafely(source: string, imports: NonNullable<ReturnType<ProviderContext["modules"]["importedSurfaceFor"]>>) {
  try {
    const options = createReactiveCheckOptions();
    return inferSymbolTypes(source, { syntaxPlugins: options.syntaxPlugins, imports });
  } catch {
    return [];
  }
}

function surfaceIsEmpty(surface: NonNullable<ReturnType<ProviderContext["modules"]["importedSurfaceFor"]>>): boolean {
  return !surface.builtins?.length && !surface.values?.length && !surface.aliases?.length && !surface.interfaces?.length;
}
