import type { SourceSymbolTable, SymbolPosition } from "./checker/index.js";

export function recoverMemberCompletionSource(text: string): string {
  return text.replace(/\.([ \t]*)(?=(?:for|in|if|of)\b|[\]\),;:\n]|$)/g, ".__tera_completion__$1");
}

export function offsetAt(source: string, position: SymbolPosition): number {
  let offset = 0;
  for (let line = 0; line < position.line && offset < source.length;) {
    const char = source[offset++];
    if (char === "\r") {
      if (source[offset] === "\n") offset++;
      line++;
    } else if (char === "\n") {
      line++;
    }
  }
  return Math.min(source.length, offset + position.character);
}

export function positionAt(source: string, offset: number): SymbolPosition {
  const target = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < target; i++) {
    const char = source[i];
    if (char === "\r") {
      if (source[i + 1] === "\n") i++;
      line++;
      lineStart = i + 1;
    } else if (char === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: target - lineStart };
}

export function highlightSpanEnd(source: string, start: number): number {
  const char = source[start];
  if (char === undefined) return Math.min(source.length, start + 1);
  if (char === "'" || char === '"' || char === "`") return stringLiteralSpanEnd(source, start);
  if (char === "(" || char === "[" || char === "{") return bracketSpanEnd(source, start);
  if (isWordChar(char)) {
    let end = start;
    while (end < source.length && isWordChar(source[end])) end++;
    return end;
  }
  return Math.min(source.length, start + 1);
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function stringLiteralSpanEnd(source: string, start: number): number {
  const delimiter = source[start];
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === delimiter) return i + 1;
    if (delimiter !== "`" && char === "\n") break;
  }
  return Math.min(source.length, start + 1);
}

function bracketSpanEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "'" || char === '"' || char === "`") {
      i = stringLiteralSpanEnd(source, i) - 1;
    } else if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

export function isStringLiteralTextPosition(source: string, position: SymbolPosition): boolean {
  return isStringLiteralTextOffset(source, offsetAt(source, position));
}

export function isStringLiteralTextOffset(source: string, offset: number): boolean {
  return stringLiteralTextPredicate(source)(offset);
}

export type SourceRange = {
  from: number;
  to: number;
};

export function stringLiteralTextPredicate(source: string): (offset: number) => boolean {
  const ranges = stringLiteralTextRanges(source);
  return (offset: number) => {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const range = ranges[mid];
      if (offset < range.from) high = mid - 1;
      else if (offset >= range.to) low = mid + 1;
      else return true;
    }
    return false;
  };
}

export function stringLiteralTextRanges(source: string): SourceRange[] {
  type Context =
    | { mode: "code" }
    | { mode: "single" | "double"; textStart: number }
    | { mode: "template"; textStart: number }
    | { mode: "templateExpression"; depth: number };

  const ranges: SourceRange[] = [];
  const stack: Context[] = [{ mode: "code" }];
  const addRange = (from: number, to: number) => {
    if (from < to) ranges.push({ from, to });
  };

  for (let i = 0; i < source.length; i++) {
    const mode = stack[stack.length - 1];
    const char = source[i];
    const next = source[i + 1];

    if (mode.mode === "single" || mode.mode === "double") {
      if (char === "\\") {
        i++;
        continue;
      }
      if ((mode.mode === "single" && char === "'") || (mode.mode === "double" && char === '"')) {
        addRange(mode.textStart, i + 1);
        stack.pop();
      }
      continue;
    }

    if (mode.mode === "template") {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === "`") {
        addRange(mode.textStart, i + 1);
        stack.pop();
      } else if (char === "$" && next === "{") {
        addRange(mode.textStart, i);
        stack.push({ mode: "templateExpression", depth: 1 });
        i++;
      }
      continue;
    }

    if (char === "'") {
      stack.push({ mode: "single", textStart: i });
    } else if (char === '"') {
      stack.push({ mode: "double", textStart: i });
    } else if (char === "`") {
      stack.push({ mode: "template", textStart: i });
    } else if (mode.mode === "templateExpression") {
      if (char === "{") {
        mode.depth++;
      } else if (char === "}") {
        mode.depth--;
        if (mode.depth === 0) {
          stack.pop();
          const parent = stack[stack.length - 1];
          if (parent.mode === "template") parent.textStart = i + 1;
        }
      }
    }
  }

  for (const mode of stack) {
    if ((mode.mode === "single" || mode.mode === "double" || mode.mode === "template") && mode.textStart < source.length) {
      addRange(mode.textStart, source.length);
    }
  }
  return ranges;
}

export function isMemberAccessSource(source: string, position: SymbolPosition): boolean {
  const line = source.replace(/\r\n?/g, "\n").split("\n")[position.line] ?? "";
  return /\.\s*[A-Za-z0-9_$]*$/.test(line.slice(0, position.character));
}

export function resolveMemberReceiverType(
  source: string,
  position: SymbolPosition,
  symbols: SourceSymbolTable,
  globals: Record<string, string> = {},
): string | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const line = lines[position.line] ?? "";
  const before = line.slice(0, position.character);
  const trailing = before.match(/\.\s*[A-Za-z0-9_$]*$/);
  if (!trailing) return null;
  const receiverSource = before.slice(0, before.length - trailing[0].length);
  const receiver = extractReceiverExpression(receiverSource) || leadingDotReceiverExpression(lines, position.line);
  return receiver ? resolveExpressionType(receiver, position, symbols, globals) : null;
}

export function extractReceiverExpression(text: string): string {
  let depth = 0;
  let start = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth === 0) {
        start = i + 1;
        break;
      }
      depth--;
    } else if (depth === 0 && /[\s=,;{}+\-*/%<>!&|?:]/.test(ch)) {
      start = i + 1;
      break;
    }
  }
  return text.slice(start).trim();
}

function leadingDotReceiverExpression(lines: string[], lineIndex: number): string | null {
  const segments: string[] = [];
  for (let cursor = lineIndex - 1; cursor >= 0; cursor--) {
    const trimmed = lines[cursor].trim();
    if (!trimmed) return null;
    if (trimmed.startsWith(".")) {
      segments.unshift(trimmed);
      continue;
    }
    const base = extractReceiverExpression(lines[cursor]);
    return base ? `${base}${segments.join("")}` : null;
  }
  return null;
}

function resolveExpressionType(
  expression: string,
  position: SymbolPosition,
  symbols: SourceSymbolTable,
  globals: Record<string, string>,
): string | null {
  const base = expression.match(/^([A-Za-z_$][\w$]*)/);
  if (!base) return null;
  let type: string | null = symbols.resolve(base[1], position)?.typeName ?? globals[base[1]] ?? base[1];
  let rest = expression.slice(base[1].length);
  if (/^\s*\(/.test(rest)) {
    rest = skipBalancedParens(rest);
    type = callResultType(type);
  }
  while (rest.length) {
    const step = rest.match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (!step || !type) break;
    rest = rest.slice(step[0].length);
    const called = /^\s*\(/.test(rest);
    if (called) rest = skipBalancedParens(rest);
    const memberType: string | null = symbols.resolveField(type, step[1], position)?.typeName ?? null;
    if (!memberType) return null;
    type = called ? returnTypeAfterArrow(memberType) : memberType;
  }
  return type;
}

function callResultType(type: string): string {
  const cleaned = type.trim();
  return cleaned.startsWith("typeof ") ? cleaned.slice("typeof ".length).trim() : returnTypeAfterArrow(cleaned);
}

function returnTypeAfterArrow(type: string): string {
  const parts = type.split("->");
  return parts.length > 1 ? parts[parts.length - 1].trim() : type;
}

function skipBalancedParens(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(i + 1);
    }
  }
  return "";
}
