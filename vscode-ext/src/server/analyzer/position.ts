import type { Position, Range } from "./types.ts";

const WORD_CHAR = /[A-Za-z0-9_$]/;

export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

export function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}

export function wordRangeAt(
  lines: string[],
  position: Position,
): { text: string; range: Range } | null {
  const line = lineAt(lines, position.line);
  let start = Math.min(position.character, line.length);
  let end = start;

  while (start > 0 && WORD_CHAR.test(line[start - 1])) start--;
  while (end < line.length && WORD_CHAR.test(line[end])) end++;
  if (start === end) return null;

  return {
    text: line.slice(start, end),
    range: {
      start: { line: position.line, character: start },
      end: { line: position.line, character: end },
    },
  };
}
