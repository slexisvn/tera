import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageData } from "../src/shared/language-data.ts";
import { DocumentAnalyzer } from "../src/server/analyzer/index.ts";
import { EventBus, type AnalyzerEvents } from "../src/server/bus.ts";
import { TypeResolver } from "../src/server/language/type-resolver.ts";
import type { ProviderContext } from "../src/server/providers/types.ts";

export const languageData = JSON.parse(readFileSync(join(import.meta.dirname, "..", "language-data.json"), "utf8")) as LanguageData;

export function contextFor(source: string): ProviderContext {
  const analyzer = new DocumentAnalyzer(languageData);
  analyzer.update("file:///test.tera", source);
  return {
    analyzer,
    languageData,
    types: new TypeResolver(languageData),
    bus: new EventBus<AnalyzerEvents>(),
  };
}
