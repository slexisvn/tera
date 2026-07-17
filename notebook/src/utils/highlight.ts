const KEYWORDS = [
  'model', 'forward', 'train', 'validate', 'optimizer', 'return', 'fn',
  'if', 'else', 'for', 'in', 'while', 'break', 'continue',
  'and', 'or', 'not', 'true', 'false', 'null',
];

const BUILTINS = [
  'tensor', 'zeros', 'ones', 'empty', 'full', 'randn', 'arange', 'eye', 'linspace', 'randperm',
  'zerosLike', 'onesLike', 'emptyLike', 'fullLike', 'randnLike',
  'where', 'cat', 'stack',
  'sum', 'min', 'max', 'avg', 'count', 'countStar',
  'DataFrame', 'col', 'lit', 'expr',
  'range', 'print', 'trace', 'graph', 'compile', 'save', 'load',
];

const TYPES = [
  'int', 'float', 'bool', 'boolean', 'str', 'string', 'number', 'void', 'none', 'null',
  'Tensor', 'DataFrame', 'Column', 'GroupedData', 'Model', 'Module', 'Record', 'Array',
  'List', 'Dict', 'Tuple', 'Optional', 'Result',
  'i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64',
  'f16', 'f32', 'f64', 'bf16', 'float16', 'float32', 'float64',
  'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
];

export const KEYWORD_SET = new Set(KEYWORDS);
export const BUILTIN_SET = new Set(BUILTINS);
export const TYPE_SET = new Set(TYPES);
export const TOKEN_RE = /#[^\n]*|"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\b\d+(?:\.\d+)?\b|[A-Za-z_]\w*/g;

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

export function tokenClass(token: string, code: string, index: number): string {
  if (token[0] === '#') return 'tok-com';
  if (token[0] === '"' || token[0] === "'") return 'tok-str';
  if (token[0] >= '0' && token[0] <= '9') return 'tok-num';
  if (nonSpaceBefore(code, index) === '.') {
    return nonSpaceAfter(code, index + token.length) === '(' ? 'tok-method' : 'tok-prop';
  }
  if (KEYWORD_SET.has(token)) return 'tok-kw';
  if (TYPE_SET.has(token) || isTypeAnnotation(code, index)) return 'tok-type';
  if (BUILTIN_SET.has(token)) return 'tok-builtin';
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
