import { maskNonCodeSource } from "tera/frontend";

export type BracedKey = {
  from: number;
  to: number;
};

type DelimiterFrame = { open: "{" | "(" | "["; expectKey: boolean };

export function bracedKeys(code: string): readonly BracedKey[] {
  const source = maskNonCodeSource(code);
  const keys: BracedKey[] = [];
  const stack: DelimiterFrame[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (isIdentifierStart(char)) {
      const start = cursor;
      cursor++;
      while (cursor < source.length && isIdentifierPart(source[cursor])) cursor++;
      const frame = stack.at(-1);
      if (frame?.open === "{" && frame.expectKey && hasBracedKeyDelimiter(source, cursor)) {
        keys.push({ from: start, to: cursor });
      }
      continue;
    }
    if (char === "[") {
      const frame = stack.at(-1);
      if (frame?.open === "{" && frame.expectKey) {
        const key = indexerKey(source, cursor);
        if (key) keys.push(key);
      }
      stack.push({ open: char, expectKey: false });
    } else if (char === "{" || char === "(") stack.push({ open: char, expectKey: char === "{" });
    else if (char === "}" || char === ")" || char === "]") popDelimiter(stack, char);
    else if (char === ",") {
      const frame = stack.at(-1);
      if (frame?.open === "{") frame.expectKey = true;
    } else if (char === ":") {
      const frame = stack.at(-1);
      if (frame?.open === "{") frame.expectKey = false;
    }
    cursor++;
  }
  return keys;
}

export function bracedKeyAt(code: string, offset: number): BracedKey | null {
  for (const key of bracedKeys(code)) if (key.from <= offset && offset < key.to) return key;
  return null;
}

function indexerKey(code: string, open: number): BracedKey | null {
  let cursor = open + 1;
  while (cursor < code.length && isInlineSpace(code[cursor])) cursor++;
  if (!isIdentifierStart(code[cursor])) return null;
  const from = cursor;
  cursor++;
  while (cursor < code.length && isIdentifierPart(code[cursor])) cursor++;
  const to = cursor;
  while (cursor < code.length && isInlineSpace(code[cursor])) cursor++;
  return code[cursor] === ":" ? { from, to } : null;
}

function popDelimiter(stack: DelimiterFrame[], close: string): void {
  const open = close === "}" ? "{" : close === ")" ? "(" : "[";
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame?.open === open) return;
  }
}

function hasBracedKeyDelimiter(code: string, index: number): boolean {
  let cursor = index;
  while (cursor < code.length && isInlineSpace(code[cursor])) cursor++;
  if (code[cursor] === "?") {
    cursor++;
    while (cursor < code.length && isInlineSpace(code[cursor])) cursor++;
  }
  return code[cursor] === ":";
}

function isInlineSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isIdentifierStart(char: string | undefined): boolean {
  return typeof char === "string" && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return typeof char === "string" && /[\w$]/.test(char);
}
