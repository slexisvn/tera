import { languageData } from "./language-data";
import { isStringLiteralTextOffset } from "tera/frontend";

const KEYWORDS = languageData.keywords;
const BUILTINS = languageData.builtins.map((item) => item.name);
const TYPES = languageData.types;

export const KEYWORD_SET = new Set(KEYWORDS);
export const BUILTIN_SET = new Set(BUILTINS);
export const TYPE_SET = new Set(TYPES);
export const TOKEN_RE = /#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\b(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[bB][01][01_]*|0[oO][0-7][0-7_]*|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)\b|(?<![\w.])\.\d[\d_]*(?:[eE][+-]?\d+)?\b|[A-Za-z_$][\w$]*/g;

export function highlightHtml(code: string): string {
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(code))) {
    out += escapeHtml(code.slice(last, match.index));
    const cls = tokenClass(match[0], code, match.index);
    out += cls ? `<span class="${cls}">${escapeHtml(match[0])}</span>` : escapeHtml(match[0]);
    last = match.index + match[0].length;
  }
  out += escapeHtml(code.slice(last));
  if (code.endsWith('\n') || code === '') out += '​';
  return out;
}

export function tokenClass(token: string, code: string, index: number, isStringText: (offset: number) => boolean = (offset) => isStringLiteralTextOffset(code, offset)): string {
  if (token[0] === '#' || token.startsWith('//')) return 'tok-com';
  if (token[0] === '"' || token[0] === "'") return 'tok-str';
  if (isStringText(index)) return 'tok-str';
  if ((token[0] >= '0' && token[0] <= '9') || (token[0] === '.' && token[1] >= '0' && token[1] <= '9')) return 'tok-num';
  if (nonSpaceBefore(code, index) === '.') {
    return nonSpaceAfter(code, index + token.length) === '(' ? 'tok-method' : 'tok-prop';
  }
  if (TYPE_SET.has(token) && isTypeAnnotation(code, index)) return 'tok-type';
  if (KEYWORD_SET.has(token)) return 'tok-kw';
  if (TYPE_SET.has(token) || isTypeAnnotation(code, index)) return 'tok-type';
  if (BUILTIN_SET.has(token)) return 'tok-builtin';
  if (nonSpaceAfter(code, index + token.length) === '(') return 'tok-method';
  if (token[0] >= 'A' && token[0] <= 'Z') return 'tok-type';
  return 'tok-ident';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char: string) => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;');
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
