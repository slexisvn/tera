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

export const KEYWORD_SET = new Set(KEYWORDS);
export const BUILTIN_SET = new Set(BUILTINS);
export const TYPE_SET = new Set();
export const TOKEN_RE = /#[^\n]*|"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\b\d+(?:\.\d+)?\b|[A-Za-z_]\w*/g;

export function highlightHtml(code) {
  let out = '';
  let last = 0;
  let match;
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

export function tokenClass(token, code, index) {
  if (token[0] === '#') return 'tok-com';
  if (token[0] === '"' || token[0] === "'") return 'tok-str';
  if (token[0] >= '0' && token[0] <= '9') return 'tok-num';
  if (nonSpaceBefore(code, index) === '.') {
    return nonSpaceAfter(code, index + token.length) === '(' ? 'tok-method' : 'tok-prop';
  }
  if (KEYWORD_SET.has(token)) return 'tok-kw';
  if (TYPE_SET.has(token)) return 'tok-type';
  if (BUILTIN_SET.has(token)) return 'tok-builtin';
  if (token[0] >= 'A' && token[0] <= 'Z') return 'tok-type';
  return 'tok-ident';
}

function escapeHtml(value) {
  return value.replace(/[&<>]/g, char => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;');
}

function nonSpaceBefore(code, index) {
  let cursor = index - 1;
  while (cursor >= 0 && (code[cursor] === ' ' || code[cursor] === '\t')) cursor--;
  return cursor >= 0 ? code[cursor] : '';
}

function nonSpaceAfter(code, index) {
  let cursor = index;
  while (cursor < code.length && (code[cursor] === ' ' || code[cursor] === '\t')) cursor++;
  return cursor < code.length ? code[cursor] : '';
}
