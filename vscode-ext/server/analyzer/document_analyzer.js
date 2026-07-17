import { buildBuiltinEnv } from './builtin_types.js';

const KEYWORDS = new Set([
  'fn', 'model', 'class', 'extends', 'constructor', 'return', 'if', 'else', 'for', 'while',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield', 'type', 'interface',
  'this', 'super', 'true', 'false', 'null', 'undefined',
]);

export class DocumentAnalyzer {
  constructor(languageData = null) {
    this._cache = new Map();
    this._builtinEnv = languageData ? buildBuiltinEnv(languageData) : buildBuiltinEnv({});
  }

  update(uri, text) {
    const prev = this._cache.get(uri);
    const result = analyze(text, this._builtinEnv);
    if (!result.symbols.flat.length && prev?.symbols?.flat?.length) result.symbols = prev.symbols;
    this._cache.set(uri, { text, ...result });
    return this._cache.get(uri);
  }

  get(uri) {
    return this._cache.get(uri) ?? null;
  }

  drop(uri) {
    this._cache.delete(uri);
  }

  uris() {
    return [...this._cache.keys()];
  }

  declaredNames(uri) {
    return this._cache.get(uri)?.symbols?.flat?.map(s => s.name) ?? [];
  }
}

function analyze(text, builtinEnv) {
  const tokens = tokenize(text);
  const symbols = buildSymbolTable(text, builtinEnv);
  const errors = syntaxDiagnostics(text);
  return { tokens, ast: null, symbols, errors };
}

function tokenize(text) {
  const out = [];
  const re = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|=>|\?\?|\.{3}|[(){}\[\].,;:=+\-*/%@<>!&|?]/g;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (const match of line.matchAll(re)) {
      const value = match[0];
      const type = /^[A-Za-z_$]/.test(value) && !KEYWORDS.has(value) ? 'identifier' : tokenType(value);
      out.push({
        type,
        value,
        line: lineIndex + 1,
        column: match.index + 1,
        endLine: lineIndex + 1,
        endColumn: match.index + value.length + 1,
      });
    }
  }
  return out;
}

function tokenType(value) {
  if (KEYWORDS.has(value)) return 'keyword';
  if (/^\d/.test(value)) return 'number';
  if (/^["']/.test(value)) return 'string';
  return 'operator';
}

function buildSymbolTable(text, builtinEnv) {
  const root = makeScope('<root>', null, 1, text.split(/\r\n?|\n/).length + 1, 0);
  const scopes = [root];
  const stack = [root];
  const fieldsByType = new Map();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const indent = raw.match(/^ */)[0].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack[stack.length - 1].endLine = index + 1;
      stack.pop();
    }
    const scope = stack[stack.length - 1];
    const line = raw.trim();
    const columnOffset = raw.length - raw.trimStart().length;
    const fn = line.match(/^(?:async\s+)?fn\*?\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
    const model = line.match(/^model\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
    const cls = line.match(/^class\s+([A-Za-z_$][\w$]*)/);
    const method = !fn && !model && line.match(/^([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/);
    const variable = line.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([^=]+))?\s*=\s*(.+)$/);
    const field = line.match(/^this\.([A-Za-z_$][\w$]*)\s*(?::\s*([^=]+))?\s*=\s*(.+)$/);

    if (fn || model || cls || (method && stack.some(s => s.kind === 'class' || s.kind === 'model'))) {
      const match = fn ?? model ?? cls ?? method;
      const symbolKind = fn || method ? 'function' : model ? 'model' : 'module';
      const scopeKind = model ? 'model' : cls ? 'class' : 'function';
      const symbol = addSymbol(scope, match[1], symbolKind, index + 1, columnOffset + 1, returnType(line));
      const next = makeScope(match[1], scope, index + 1, lines.length + 1, indent, scopeKind);
      scopes.push(next);
      scope.children.push(next);
      stack.push(next);
      if (model || cls) fieldsByType.set(match[1], []);
      if ((fn || model || method) && match[2]) addParams(next, match[2], index + 1, raw.indexOf('(') + 2);
      if (model && match[2]) {
        for (const param of parseParams(match[2])) fieldsByType.get(match[1]).push({ name: param.name, kind: 'field', line: index + 1, column: param.column, typeName: param.typeName });
      }
      symbol.scope = next;
      continue;
    }

    if (variable) {
      const name = variable[1];
      addSymbol(scope, name, 'variable', index + 1, columnOffset + 1, cleanType(variable[2]) ?? inferAssignmentType(variable[3], builtinEnv));
      continue;
    }

    if (field) {
      const owner = currentType(stack);
      if (owner) fieldsByType.get(owner)?.push({ name: field[1], kind: 'field', line: index + 1, column: columnOffset + 6, typeName: cleanType(field[2]) ?? inferAssignmentType(field[3], builtinEnv) });
    }
  }

  while (stack.length > 1) {
    stack[stack.length - 1].endLine = lines.length + 1;
    stack.pop();
  }

  const flat = scopes.flatMap(scope => scope.symbols);
  return {
    scopes,
    root,
    flat,
    findScopeAt: position => findScopeAt(root, position.line + 1),
    resolve: (name, position) => resolveName(root, name, position.line + 1),
    resolveField: (typeName, fieldName) => fieldsByType.get(typeName)?.find(f => f.name === fieldName) ?? null,
  };
}

function makeScope(name, parent, startLine, endLine, indent, kind = 'scope') {
  return { name, kind, parent, children: [], symbols: [], startLine, endLine, indent };
}

function addSymbol(scope, name, kind, line, column, typeName = null) {
  const symbol = { name, kind, line, column, typeName };
  scope.symbols.push(symbol);
  return symbol;
}

function addParams(scope, params, line, baseColumn) {
  for (const param of parseParams(params)) addSymbol(scope, param.name, 'parameter', line, baseColumn + param.column - 1, param.typeName);
}

function parseParams(params) {
  const out = [];
  let offset = 0;
  for (const raw of params.split(',')) {
    const match = raw.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([^=]+?))?(?:\s*=.*)?$/);
    if (match) out.push({ name: match[1], typeName: cleanType(match[2]), column: offset + raw.indexOf(match[1]) + 1 });
    offset += raw.length + 1;
  }
  return out;
}

function cleanType(type) {
  return type?.trim().replace(/\s+$/, '') || null;
}

function returnType(line) {
  return cleanType(line.match(/->\s*([^:]+):/)?.[1]);
}

function inferAssignmentType(value, builtinEnv) {
  const call = value?.trim().match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1];
  return call && builtinEnv.builtinNames.has(call) ? call : null;
}

function currentType(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind === 'class' || stack[i].kind === 'model') return stack[i].name;
  }
  return null;
}

function findScopeAt(scope, line) {
  for (const child of scope.children) {
    if (line >= child.startLine && line <= child.endLine) return findScopeAt(child, line);
  }
  return scope;
}

function resolveName(root, name, line) {
  let scope = findScopeAt(root, line);
  while (scope) {
    const found = [...scope.symbols].reverse().find(s => s.name === name && s.line <= line);
    if (found) return found;
    scope = scope.parent;
  }
  return null;
}

function syntaxDiagnostics(text) {
  const errors = [];
  const stack = [];
  let quote = '';
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0, line = 1, column = 1; i < text.length; i++, column++) {
    const ch = text[i];
    if (ch === '\n') {
      line++;
      column = 0;
      continue;
    }
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, line, column });
    else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      if (!open || open.ch !== pairs[ch]) errors.push({ message: `unmatched '${ch}'`, line, column, source: 'syntax' });
    }
  }
  if (quote) errors.push({ message: 'unterminated string literal', line: 1, column: 1, source: 'syntax' });
  for (const open of stack) errors.push({ message: `unclosed '${open.ch}'`, line: open.line, column: open.column, source: 'syntax' });
  return errors;
}
