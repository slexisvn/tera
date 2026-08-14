import { isMemberAccessSource, resolveMemberReceiverType } from "tera/frontend";
import type { AnalyzedDocument, Position } from "../analyzer/index.ts";
import type { ProviderContext } from "../providers/types.ts";

export function isMemberAccess(document: AnalyzedDocument, position: Position): boolean {
  return isMemberAccessSource(document.text, position);
}

export function resolveReceiverType(context: ProviderContext, document: AnalyzedDocument, position: Position): string | null {
  return resolveMemberReceiverType(document.text, position, document.symbols, context.languageData.globalNamespaces);
}
