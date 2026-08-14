import { createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import {
  buildSourceSymbolTable,
  inferSymbolTypes,
  positionAt,
  recoverMemberCompletionSource,
} from "../../frontend/index.js";
import type { CheckSourceOptions } from "../../frontend/checker/index.js";
import type { Analyzer, SessionAnalysis } from "./types.js";

function combine(sessionSource: string, fragment: string): { text: string; base: number } {
  if (!sessionSource) return { text: fragment, base: 0 };
  return { text: `${sessionSource}\n${fragment}`, base: sessionSource.length + 1 };
}

export function createAnalyzer(): Analyzer {
  const options = createReactiveCheckOptions() as CheckSourceOptions;
  const inferOptions = {
    syntaxPlugins: options.syntaxPlugins,
    builtins: options.builtins,
    aliases: options.aliases,
    interfaces: options.interfaces,
  };

  let cacheKey = "\0";
  let cached: SessionAnalysis | null = null;

  const inferSafely = (source: string) => {
    try {
      return inferSymbolTypes(source, inferOptions);
    } catch {
      return [];
    }
  };

  return {
    analyze(sessionSource, fragment) {
      const { text, base } = combine(sessionSource, fragment);
      if (cached && cacheKey === text) return cached;
      const recovered = recoverMemberCompletionSource(text);
      const symbols = buildSourceSymbolTable(recovered, inferSafely(recovered), {
        syntaxPlugins: options.syntaxPlugins,
      });
      cacheKey = text;
      cached = {
        source: text,
        symbols,
        positionOf: (fragmentOffset) => positionAt(text, base + fragmentOffset),
      };
      return cached;
    },
  };
}
