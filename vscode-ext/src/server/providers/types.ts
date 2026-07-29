import type { Connection, SemanticTokensLegend } from "vscode-languageserver/node.js";
import type { LanguageData } from "../../shared/language-data.ts";
import type { DocumentAnalyzer } from "../analyzer/index.ts";
import type { AnalyzerBus } from "../bus.ts";
import type { TypeResolver } from "../language/type-resolver.ts";

export type ProviderContext = {
  analyzer: DocumentAnalyzer;
  languageData: LanguageData;
  types: TypeResolver;
  bus: AnalyzerBus;
};

export type Provider = {
  id: string;
  legend?: SemanticTokensLegend;
  register(connection: Connection, context: ProviderContext): void;
};

export function defineProvider(provider: Provider): Provider {
  return provider;
}
