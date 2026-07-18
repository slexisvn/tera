import { TokenType, tokenize } from "@slexisvn/tera/frontend";
import type { Token } from "@slexisvn/tera/frontend";
import type { AnalyzedToken, TokenKind } from "./types.ts";

const KIND_BY_TOKEN_TYPE: Record<string, TokenKind> = {
  [TokenType.Keyword]: "keyword",
  [TokenType.Identifier]: "identifier",
  [TokenType.Number]: "number",
  [TokenType.String]: "string",
  [TokenType.TemplateLiteral]: "string",
  [TokenType.RegExp]: "string",
  [TokenType.Punctuator]: "operator",
};

export function analyzeTokens(text: string): AnalyzedToken[] {
  let raw: Token[];
  try {
    raw = tokenize(text);
  } catch {
    return [];
  }

  const out: AnalyzedToken[] = [];
  for (const token of raw) {
    if (token.type === TokenType.EOF) continue;
    const value = stringifyValue(token);
    out.push({
      type: KIND_BY_TOKEN_TYPE[token.type] ?? "operator",
      value,
      line: token.line,
      column: token.column,
      endLine: token.line,
      endColumn: token.column + value.length,
    });
  }
  return out;
}

function stringifyValue(token: Token): string {
  const { value } = token;
  if (typeof value === "string") return value;
  if ("pattern" in value) return `/${value.pattern}/${value.flags}`;
  return value.parts.join("");
}
