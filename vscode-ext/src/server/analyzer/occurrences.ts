import { analyzeTokens } from "./tokens.ts";
import type { AnalyzedToken, Range } from "./types.ts";

export function nameOccurrences(
  source: string,
  name: string,
  namespaces: ReadonlySet<string> = new Set(),
  plain = true,
): Range[] {
  const tokens = analyzeTokens(source);
  const ranges: Range[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.type !== "identifier" || token.value !== name) continue;
    if (!reachable(tokens, at, namespaces, plain)) continue;
    ranges.push(rangeOf(token));
  }
  return ranges;
}

function reachable(
  tokens: AnalyzedToken[],
  at: number,
  namespaces: ReadonlySet<string>,
  plain: boolean,
): boolean {
  if (tokens[at - 1]?.value !== ".") return plain;
  const receiver = tokens[at - 2];
  return receiver !== undefined && receiver.type === "identifier" && namespaces.has(receiver.value);
}

function rangeOf(token: AnalyzedToken): Range {
  return {
    start: { line: token.line - 1, character: token.column - 1 },
    end: { line: token.endLine - 1, character: token.endColumn - 1 },
  };
}
