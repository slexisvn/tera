import { languageData } from "./language-data";
import { isStringLiteralTextOffset } from "tera/frontend";
import { bracedKeys } from "./source-context";

const KEYWORDS = languageData.keywords;
const BUILTINS = languageData.builtins.map((item) => item.name);
const TYPES = languageData.types;
const MODEL_HOOKS = new Set(["forward", "train", "validate", "optimizer"]);

export const KEYWORD_SET = new Set(KEYWORDS);
export const BUILTIN_SET = new Set(BUILTINS);
export const TYPE_SET = new Set(TYPES);
export const TOKEN_RE = /#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\b(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[bB][01][01_]*|0[oO][0-7][0-7_]*|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)\b|(?<![\w.])\.\d[\d_]*(?:[eE][+-]?\d+)?\b|[A-Za-z_$][\w$]*/g;

type CachedNameClasses = { code: string; classes: ReadonlyMap<number, string> };

let cachedNameClasses: CachedNameClasses | null = null;

export function tokenClass(token: string, code: string, index: number, isStringText: (offset: number) => boolean = (offset) => isStringLiteralTextOffset(code, offset)): string {
  if (token[0] === '#' || token.startsWith('//')) return 'tok-com';
  if (token[0] === '"' || token[0] === "'") return 'tok-str';
  if (isStringText(index)) return 'tok-str';
  if ((token[0] >= '0' && token[0] <= '9') || (token[0] === '.' && token[1] >= '0' && token[1] <= '9')) return 'tok-num';
  if (nonSpaceBefore(code, index) === '.') {
    return nonSpaceAfter(code, index + token.length) === '(' ? 'tok-method' : 'tok-prop';
  }
  const memberClass = contextualNameClasses(code).get(index);
  if (memberClass) return memberClass;
  if (isModelHookLabel(token, code, index)) return 'tok-method';
  if (TYPE_SET.has(token) && isTypePosition(code, index)) return 'tok-type';
  if (KEYWORD_SET.has(token)) return 'tok-kw';
  if (TYPE_SET.has(token) || isTypePosition(code, index)) return 'tok-type';
  if (BUILTIN_SET.has(token)) return 'tok-builtin';
  if (nonSpaceAfter(code, index + token.length) === '(') return 'tok-method';
  if (token[0] >= 'A' && token[0] <= 'Z') return 'tok-type';
  return 'tok-ident';
}

function nonSpaceBefore(code: string, index: number): string {
  let cursor = index - 1;
  while (cursor >= 0 && (code[cursor] === ' ' || code[cursor] === '\t')) cursor--;
  return cursor >= 0 ? code[cursor] : '';
}

function nonSpaceAfter(code: string, index: number): string {
  let cursor = index;
  while (cursor < code.length && (code[cursor] === ' ' || code[cursor] === '\t')) cursor++;
  return cursor < code.length ? code[cursor] : '';
}

function isTypeAnnotation(code: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && (code[cursor] === ' ' || code[cursor] === '\t')) cursor--;
  if (cursor < 0) return false;
  if (code[cursor] === ':') return true;
  if (code[cursor] === '>' && cursor > 0 && code[cursor - 1] === '-') return true;
  return false;
}

function isTypePosition(code: string, index: number): boolean {
  if (isTypeAnnotation(code, index)) return true;
  const before = nonSpaceBefore(code, index);
  return before === "<" || before === "|" || before === "&";
}

function contextualNameClasses(code: string): ReadonlyMap<number, string> {
  if (cachedNameClasses?.code === code) return cachedNameClasses.classes;
  const classes = new Map<number, string>();
  collectTypeParameters(code, classes);
  collectInterfaceMembers(code, classes);
  collectLiteralKeys(code, classes);
  cachedNameClasses = { code, classes };
  return classes;
}

function collectTypeParameters(code: string, classes: Map<number, string>): void {
  let lineStart = 0;
  while (lineStart <= code.length) {
    const lineEnd = lineEndOf(code, lineStart);
    const line = code.slice(lineStart, lineEnd);
    const match = /^\s*(?:type|interface|fn|function)\s+[A-Za-z_$][\w$]*\s*</.exec(line);
    if (match) {
      const open = line.indexOf("<", match[0].length - 1);
      const close = matchingAngle(line, open);
      if (open >= 0 && close > open) {
        const params = line.slice(open + 1, close);
        const re = /[A-Za-z_$][\w$]*/g;
        let found: RegExpExecArray | null;
        while ((found = re.exec(params))) classes.set(lineStart + open + 1 + found.index, 'tok-type');
      }
    }
    if (lineEnd >= code.length) break;
    lineStart = code[lineEnd] === '\r' && code[lineEnd + 1] === '\n' ? lineEnd + 2 : lineEnd + 1;
  }
}

function matchingAngle(line: string, open: number): number {
  let depth = 0;
  for (let cursor = open; cursor < line.length; cursor++) {
    if (line[cursor] === "<") depth++;
    else if (line[cursor] === ">") {
      depth--;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function collectInterfaceMembers(code: string, classes: Map<number, string>): void {
  let lineStart = 0;
  while (lineStart <= code.length) {
    const lineEnd = lineEndOf(code, lineStart);
    const line = code.slice(lineStart, lineEnd);
    const match = /^([ \t]*)([A-Za-z_$][\w$]*)\s*(?::|\()/.exec(line);
    if (match) {
      const indent = match[1].length;
      const header = nearestOuterHeader(code, lineStart, indent);
      if (header !== null && /^interface\b/.test(header)) {
        const offset = lineStart + indent;
        const rest = line.slice(indent + match[2].length);
        classes.set(offset, /^(?:\s*\(|\s*:\s*(?:\(|fn\b))/.test(rest) ? 'tok-method' : 'tok-prop');
      }
    }
    if (lineEnd >= code.length) break;
    lineStart = code[lineEnd] === '\r' && code[lineEnd + 1] === '\n' ? lineEnd + 2 : lineEnd + 1;
  }
}

function nearestOuterHeader(code: string, lineStart: number, indent: number): string | null {
  let end = lineStart - 1;
  while (end >= 0) {
    if (code[end] === '\n' || code[end] === '\r') {
      end--;
      continue;
    }
    const start = lineStartOf(code, end);
    const text = code.slice(start, end + 1);
    const trimmed = text.trim();
    if (trimmed !== '') {
      const parentIndent = indentationOfText(text);
      if (parentIndent < indent) return trimmed;
    }
    end = start - 1;
  }
  return null;
}

function collectLiteralKeys(code: string, classes: Map<number, string>): void {
  for (const key of bracedKeys(code)) if (!classes.has(key.from)) classes.set(key.from, 'tok-prop');
}

function lineStartOf(code: string, index: number): number {
  let cursor = index - 1;
  while (cursor >= 0 && code[cursor] !== '\n' && code[cursor] !== '\r') cursor--;
  return cursor + 1;
}

function lineEndOf(code: string, index: number): number {
  let cursor = index;
  while (cursor < code.length && code[cursor] !== '\n' && code[cursor] !== '\r') cursor++;
  return cursor;
}

function indentationOfText(text: string): number {
  return text.length - text.trimStart().length;
}

function isModelHookLabel(token: string, code: string, index: number): boolean {
  if (!MODEL_HOOKS.has(token)) return false;

  let lineStart = index - 1;
  while (lineStart >= 0 && code[lineStart] !== '\n' && code[lineStart] !== '\r') lineStart--;
  for (let cursor = lineStart + 1; cursor < index; cursor++) {
    if (code[cursor] !== ' ' && code[cursor] !== '\t') return false;
  }

  let cursor = index + token.length;
  while (cursor < code.length && (code[cursor] === ' ' || code[cursor] === '\t')) cursor++;
  if (code[cursor] === ':') return true;
  if (code[cursor] !== '(') return false;

  let depth = 0;
  for (; cursor < code.length; cursor++) {
    const char = code[cursor];
    if (char === '\n' || char === '\r') return false;
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === ':' && depth === 0) return true;
  }
  return false;
}
