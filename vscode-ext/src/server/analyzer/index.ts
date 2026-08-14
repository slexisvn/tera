import { createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import { inferSymbolTypes, parse, recoverMemberCompletionSource } from "tera/frontend";
import type { LanguageData } from "@/shared/language-data";
import { analyzeDiagnostics } from "./diagnostics.ts";
import { splitLines } from "./position.ts";
import { buildSymbolTable } from "./symbols.ts";
import { analyzeTokens } from "./tokens.ts";
import type { AnalyzedDocument } from "./types.ts";

export class DocumentAnalyzer {
  private readonly cache = new Map<string, AnalyzedDocument>();

  constructor(_languageData: Partial<LanguageData> = {}) {}

  update(uri: string, text: string): AnalyzedDocument {
    const previous = this.cache.get(uri);
    const analyzed = analyze(text);
    if (!analyzed.symbols.flat.length && previous?.symbols.flat.length) {
      analyzed.symbols = previous.symbols;
    }
    this.cache.set(uri, analyzed);
    return analyzed;
  }

  get(uri: string): AnalyzedDocument | null {
    return this.cache.get(uri) ?? null;
  }

  drop(uri: string): void {
    this.cache.delete(uri);
  }

  uris(): string[] {
    return [...this.cache.keys()];
  }

  declaredNames(uri: string): string[] {
    return this.cache.get(uri)?.symbols.flat.map((symbol) => symbol.name) ?? [];
  }
}

function analyze(text: string): AnalyzedDocument {
  const lines = splitLines(text);
  const symbolText = recoverMemberCompletionSource(text);
  const options = createReactiveCheckOptions();
  const inferred = inferTypesSafely(symbolText);
  return {
    text,
    lines,
    tokens: analyzeTokens(text),
    ast: parseSafely(text),
    symbols: buildSymbolTable(symbolText, inferred, options.syntaxPlugins),
    errors: analyzeDiagnostics(text),
  };
}

function inferTypesSafely(text: string): Array<{ name: string; line: number; column: number; type: string }> {
  try {
    return inferSymbolTypes(text, createReactiveCheckOptions());
  } catch {
    return [];
  }
}


function parseSafely(text: string): unknown {
  try {
    return parse(text, { syntaxPlugins: createReactiveCheckOptions().syntaxPlugins });
  } catch {
    return null;
  }
}

export type { AnalyzedDocument };
export * from "./types.ts";
