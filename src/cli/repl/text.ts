import { extractReceiverExpression } from "../../frontend/index.js";
import { INDENT_UNIT } from "./config.js";

const TRAILING_WORD = /[A-Za-z_$][\w$]*$/;

export type WordSplit = { word: string; prefix: string };

export function splitTrailingWord(line: string): WordSplit {
  const match = line.match(TRAILING_WORD);
  if (!match) return { word: "", prefix: line };
  return { word: match[0], prefix: line.slice(0, line.length - match[0].length) };
}

export function nonSpaceBefore(source: string, index: number): string {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  return cursor >= 0 ? source[cursor] : "";
}

export function isMemberAccess(prefix: string): boolean {
  return nonSpaceBefore(prefix, prefix.length) === ".";
}

export function ownerExpression(prefix: string): string | null {
  const withoutDot = prefix.replace(/\.\s*$/, "");
  const receiver = extractReceiverExpression(withoutDot);
  return receiver || null;
}

export function joinSource(base: string, next: string): string {
  if (!next) return base;
  return base ? `${base}\n${next}` : next;
}

export function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count++;
  return count;
}

export function indentString(width: number): string {
  return " ".repeat(Math.max(0, width));
}

export function increaseIndent(width: number): number {
  return width + INDENT_UNIT;
}

export function lastNonBlankLine(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}
