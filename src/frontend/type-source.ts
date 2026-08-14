import type { Token } from "./lexer/index.js";

const REST_MARKER = "...";

export function restParameterType(name: string, element: string): string {
  return `${REST_MARKER}${name}: ${element}`;
}

export function restParameterSource(source: string): string | null {
  return source.startsWith(REST_MARKER) ? source.slice(REST_MARKER.length) : null;
}

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
