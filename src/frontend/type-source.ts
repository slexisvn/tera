import type { Token } from "./lexer/index.js";

export function typeSourceFromTokens(tokens: readonly Token[]): string {
  return tokens.map((tok) => String(tok.value)).join(" ")
    .replace(/\s*\[\s*\]/g, "[]")
    .replace(/\s*<\s*/g, "<")
    .replace(/\s*>\s*/g, ">")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s*->\s*/g, " -> ")
    .replace(/\s+/g, " ")
    .trim();
}
