import { Lexer, TokenType, type Token } from "../../frontend/index.js";
import { INDENT_UNIT } from "./config.js";
import { increaseIndent, indentString, lastNonBlankLine, leadingSpaces } from "./text.js";

export type Completeness = { complete: boolean; indent: string };

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const CONTINUATION_PUNCT = new Set([
  "+", "-", "*", "/", "%", "**", "=", "==", "===", "!=", "!==",
  "<", ">", "<=", ">=", "&&", "||", "??", "&", "|", "^", "<<", ">>",
  "->", "=>", ",", ".", "+=", "-=", "*=", "/=", "%=", "?.",
]);
const CONTINUATION_KEYWORD = new Set(["and", "or", "not", "in", "instanceof", "typeof", "new", "delete"]);

type LineInfo = { startDepth: number; endDepth: number; last: Token };

function tokenizeSafely(source: string): { tokens: Token[]; unterminated: boolean; failed: boolean } {
  try {
    return { tokens: new Lexer(source).tokenize(), unterminated: false, failed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { tokens: [], unterminated: /Unterminated/.test(message), failed: true };
  }
}

function collectLines(tokens: Token[]): { byLine: Map<number, LineInfo>; endDepth: number; last: Token | null } {
  const byLine = new Map<number, LineInfo>();
  let depth = 0;
  let last: Token | null = null;
  for (const token of tokens) {
    if (token.type === TokenType.EOF) break;
    if (!byLine.has(token.line)) byLine.set(token.line, { startDepth: depth, endDepth: depth, last: token });
    if (token.type === TokenType.Punctuator) {
      const value = token.value as string;
      if (OPENERS.has(value)) depth++;
      else if (CLOSERS.has(value) && depth > 0) depth--;
    }
    const info = byLine.get(token.line)!;
    info.endDepth = depth;
    info.last = token;
    last = token;
  }
  return { byLine, endDepth: depth, last };
}

function isContinuation(token: Token | null): boolean {
  if (!token) return false;
  if (token.type === TokenType.Punctuator) return CONTINUATION_PUNCT.has(token.value as string);
  if (token.type === TokenType.Keyword) return CONTINUATION_KEYWORD.has(token.value as string);
  return false;
}

function endsBlock(info: LineInfo): boolean {
  return info.endDepth === 0 && info.last.type === TokenType.Punctuator && info.last.value === ":";
}

type BlockState = { indents: number[]; pendingHeader: boolean; pendingIndent: number };

function trackBlocks(lines: string[], byLine: Map<number, LineInfo>): BlockState {
  const state: BlockState = { indents: [0], pendingHeader: false, pendingIndent: 0 };
  for (const [lineNo, info] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    if (info.startDepth !== 0) continue;
    const indent = leadingSpaces(lines[lineNo - 1] ?? "");
    if (state.pendingHeader) {
      if (indent > state.indents[state.indents.length - 1]) state.indents.push(indent);
      state.pendingHeader = false;
    } else {
      while (state.indents.length > 1 && indent < state.indents[state.indents.length - 1]) state.indents.pop();
    }
    if (endsBlock(info)) {
      state.pendingHeader = true;
      state.pendingIndent = indent;
    }
  }
  return state;
}

export function assess(buffer: string): Completeness {
  const normalized = buffer.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return { complete: true, indent: "" };

  const lines = normalized.split("\n");
  const base = leadingSpaces(lastNonBlankLine(lines));
  const lastBlank = !(lines[lines.length - 1] ?? "").trim();

  const { tokens, unterminated, failed } = tokenizeSafely(normalized);
  if (failed) {
    if (unterminated) return { complete: false, indent: indentString(base) };
    return { complete: true, indent: "" };
  }

  const { byLine, endDepth, last } = collectLines(tokens);
  if (endDepth > 0) return { complete: false, indent: indentString(increaseIndent(base)) };

  const blocks = trackBlocks(lines, byLine);
  if (blocks.pendingHeader) {
    return { complete: false, indent: indentString(blocks.pendingIndent + INDENT_UNIT) };
  }
  if (isContinuation(last)) return { complete: false, indent: indentString(base) };

  const insideBlock = blocks.indents.length > 1;
  if (insideBlock && !lastBlank) {
    return { complete: false, indent: indentString(blocks.indents[blocks.indents.length - 1]) };
  }
  return { complete: true, indent: "" };
}
