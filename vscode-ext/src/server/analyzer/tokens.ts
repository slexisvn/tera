import { TokenType, tokenize, type Token } from "tera/frontend";
import { splitLines } from "./position.ts";
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

  const lines = splitLines(text);
  const out: AnalyzedToken[] = [];
  for (const token of raw) {
    if (
      token.type === TokenType.EOF ||
      token.type === TokenType.Newline ||
      token.type === TokenType.Indent ||
      token.type === TokenType.Dedent
    ) continue;
    const value = stringifyValue(token);
    const span = tokenSpan(token, value, lines);
    out.push({
      type: KIND_BY_TOKEN_TYPE[token.type] ?? "operator",
      value,
      line: span.line,
      column: span.column,
      endLine: span.endLine,
      endColumn: span.endColumn,
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

function tokenSpan(token: Token, value: string, lines: string[]): Pick<AnalyzedToken, "line" | "column" | "endLine" | "endColumn"> {
  if (token.type === TokenType.String) {
    const quoted = delimitedSpan(token, lines, new Set(["\"", "'"]));
    if (quoted) return quoted;
  }
  if (token.type === TokenType.TemplateLiteral) {
    const template = delimitedSpan(token, lines, new Set(["`"]));
    if (template) return template;
  }
  return {
    line: token.line,
    column: token.column,
    endLine: token.line,
    endColumn: token.column + value.length,
  };
}

function delimitedSpan(token: Token, lines: string[], delimiters: Set<string>): Pick<AnalyzedToken, "line" | "column" | "endLine" | "endColumn"> | null {
  const start = literalStart(lines, token.line, token.column, delimiters);
  if (!start) return null;
  let escaped = false;
  for (let lineIndex = start.line - 1; lineIndex < lines.length; lineIndex++) {
    const text = lines[lineIndex] ?? "";
    const offset = lineIndex === start.line - 1 ? start.column : 0;
    for (let index = offset + 1; index < text.length; index++) {
      const ch = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === start.delimiter) {
        return {
          line: start.line,
          column: start.column + 1,
          endLine: lineIndex + 1,
          endColumn: index + 2,
        };
      }
    }
  }
  return null;
}

function literalStart(lines: string[], line: number, column: number, delimiters: Set<string>): { line: number; column: number; delimiter: string } | null {
  const text = lines[line - 1] ?? "";
  const index = Math.max(0, column - 1);
  if (delimiters.has(text[index])) return { line, column: index, delimiter: text[index] };
  if (index > 0 && delimiters.has(text[index - 1])) return { line, column: index - 1, delimiter: text[index - 1] };
  return null;
}
