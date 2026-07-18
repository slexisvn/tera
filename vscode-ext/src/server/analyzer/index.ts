import { parse } from "@slexisvn/tera/frontend";
import type { LanguageData } from "../../shared/language-data.ts";
import { buildBuiltinEnv, type BuiltinEnv } from "./builtin-env.ts";
import { analyzeDiagnostics } from "./diagnostics.ts";
import { splitLines } from "./position.ts";
import { buildSymbolTable } from "./symbols.ts";
import { analyzeTokens } from "./tokens.ts";
import type { AnalyzedDocument } from "./types.ts";

export class DocumentAnalyzer {
  private readonly cache = new Map<string, AnalyzedDocument>();
  private readonly env: BuiltinEnv;

  constructor(languageData: Partial<LanguageData> = {}) {
    this.env = buildBuiltinEnv(languageData);
  }

  update(uri: string, text: string): AnalyzedDocument {
    const previous = this.cache.get(uri);
    const analyzed = analyze(text, this.env);
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

function analyze(text: string, env: BuiltinEnv): AnalyzedDocument {
  const lines = splitLines(text);
  return {
    text,
    lines,
    tokens: analyzeTokens(text),
    ast: parseSafely(text),
    symbols: buildSymbolTable(lines, env),
    errors: analyzeDiagnostics(text),
  };
}

function parseSafely(text: string): unknown {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

export type { AnalyzedDocument };
export * from "./types.ts";
