import type { SourceSymbolTable, SymbolPosition } from "./checker/index.js";
import { maskNonCodeSource } from "./source-context.js";

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
  return resolveMemberReceiverTypeFromSource(receiverSourceContext(source), position, symbols, globals);
}

export function createMemberReceiverTypeResolver(
  source: string,
  symbols: SourceSymbolTable,
  globals: Record<string, string> = {},
): (position: SymbolPosition) => string | null {
  const context = receiverSourceContext(source);
  return (position) => resolveMemberReceiverTypeFromSource(context, position, symbols, globals);
}

export function memberReceiverExpression(source: string, position: SymbolPosition): string | null {
  return memberReceiverExpressionFromSource(receiverSourceContext(source), position);
}

type ReceiverSourceContext = {
  source: string;
  masked: string;
  lines: string[];
  lineOffsets: number[];
};

function receiverSourceContext(source: string): ReceiverSourceContext {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lineOffsets = [0];
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] === "\n") lineOffsets.push(index + 1);
  }
  return {
    source: normalized,
    masked: maskReceiverSource(normalized),
    lines: normalized.split("\n"),
    lineOffsets,
  };
}

function resolveMemberReceiverTypeFromSource(
  context: ReceiverSourceContext,
  position: SymbolPosition,
  symbols: SourceSymbolTable,
  globals: Record<string, string>,
): string | null {
  const receiver = memberReceiverExpressionFromSource(context, position);
  return receiver ? resolveExpressionType(receiver, position, symbols, globals) : null;
}

function memberReceiverExpressionFromSource(
  context: ReceiverSourceContext,
  position: SymbolPosition,
): string | null {
  const line = context.lines[position.line] ?? "";
  const before = line.slice(0, position.character);
  const trailing = before.match(/\.[ \t]*[A-Za-z0-9_$]*$/);
  if (!trailing) return null;
  const lineOffset = context.lineOffsets[position.line] ?? context.source.length;
  const receiverEnd = Math.min(context.source.length, lineOffset + before.length - trailing[0].length);
  const receiver = extractReceiverExpressionAt(context.source, context.masked, receiverEnd);
  if (hasExpressionBase(receiver)) return receiver;
  const leading = leadingDotReceiverExpression(context.lines, position.line);
  return hasExpressionBase(leading) ? leading : null;
}

export function extractReceiverExpression(text: string): string {
  return extractReceiverExpressionAt(text, maskReceiverSource(text), text.length);
}

function maskReceiverSource(source: string): string {
  const masked = source.split("");
  for (const range of stringLiteralTextRanges(source)) {
    for (let index = range.from; index < range.to; index++) {
      if (source[index] !== "\n" && source[index] !== "\r") masked[index] = " ";
    }
  }
  return maskNonCodeSource(masked.join(""));
}

function extractReceiverExpressionAt(text: string, masked: string, endOffset: number): string {
  let end = Math.max(0, Math.min(masked.length, endOffset));
  while (end > 0 && /\s/.test(masked[end - 1])) end--;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let start = 0;
  for (let i = end - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === ")") parenDepth++;
    else if (ch === "]") bracketDepth++;
    else if (ch === "}") braceDepth++;
    else if (ch === "(") {
      if (parenDepth === 0) {
        start = i + 1;
        break;
      }
      parenDepth--;
    } else if (ch === "[") {
      if (bracketDepth === 0) {
        start = i + 1;
        break;
      }
      bracketDepth--;
    } else if (ch === "{") {
      if (braceDepth === 0) {
        start = i + 1;
        break;
      }
      braceDepth--;
    } else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && /[\s=,;+\-*/%<>!&|?:]/.test(ch)) {
      start = i + 1;
      break;
    }
  }
  return text.slice(start, end).trim();
}

function hasExpressionBase(expression: string | null): expression is string {
  return expression !== null && /^[A-Za-z_$][\w$]*/.test(expression);
}

function leadingDotReceiverExpression(lines: readonly string[], lineIndex: number): string | null {
  const segments: string[] = [];
  for (let cursor = lineIndex - 1; cursor >= 0; cursor--) {
    const trimmed = lines[cursor].trim();
    if (!trimmed) return null;
    if (trimmed.startsWith(".")) {
      segments.unshift(trimmed);
      continue;
    }
    const base = extractReceiverExpression(lines[cursor]);
    return hasExpressionBase(base) ? `${base}${segments.join("")}` : null;
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
