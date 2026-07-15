import { tokenize, LangSyntaxError } from '../vendor/tokenizer.js';
import { parse } from '../vendor/parser.js';
import { typecheckWithTypes } from '../vendor/typechecker.js';
import { buildSymbolTable } from '../vendor/symbol_table.js';
import { buildBuiltinEnv } from './builtin_types.js';

export class DocumentAnalyzer {
  constructor(languageData = null) {
    this._cache = new Map();
    this._builtinEnv = languageData ? buildBuiltinEnv(languageData) : null;
  }

  update(uri, text) {
    const prev = this._cache.get(uri);
    const result = analyze(text, this._builtinEnv);
    if (!result.ast && prev?.symbols && prev.symbols.flat.length) {
      result.symbols = prev.symbols;
    }
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
    const doc = this._cache.get(uri);
    if (!doc || !doc.symbols || !doc.symbols.flat) return [];
    return doc.symbols.flat.map(s => s.name);
  }
}

function analyze(text, builtinEnv) {
  const tokens = safeTokenize(text);
  const ast = safeParse(text);
  const errors = [];
  if (tokens.error) errors.push(tokens.error);
  if (ast.error) errors.push(ast.error);
  let types = null;
  if (ast.program && builtinEnv) {
    const checked = runTypecheck(ast.program, builtinEnv);
    errors.push(...checked.diagnostics);
    types = checked.types;
  }
  let symbols = ast.program ? buildSymbolTable(ast.program, text, types) : null;
  if (!symbols) {
    const fallback = parseTruncated(text);
    if (fallback) symbols = buildSymbolTable(fallback, text);
  }
  if (!symbols) symbols = emptySymbolTable();
  return { tokens: tokens.value, ast: ast.program, symbols, errors };
}

function runTypecheck(program, builtinEnv) {
  try {
    const { diagnostics, types } = typecheckWithTypes(program, builtinEnv);
    return {
      diagnostics: diagnostics.map(e => ({
        message: (e.message ?? '').replace(/ at \d+:\d+$/, ''),
        line: e.line ?? 1,
        column: e.column ?? 1,
        source: 'typecheck',
      })),
      types,
    };
  } catch {
    return { diagnostics: [], types: null };
  }
}

function parseTruncated(text) {
  const lines = text.split('\n');
  for (let drop = 1; drop <= Math.min(5, lines.length); drop++) {
    const trimmed = lines.slice(0, lines.length - drop).join('\n');
    if (!trimmed.trim()) return null;
    try {
      return parse(trimmed);
    } catch {}
  }
  return null;
}

function emptySymbolTable() {
  const empty = { name: '<empty>', parent: null, children: [], symbols: [], startLine: 1, endLine: 1 };
  return {
    scopes: [empty],
    root: empty,
    flat: [],
    findScopeAt: () => empty,
    resolve: () => null,
  };
}

function safeTokenize(text) {
  try {
    return { value: tokenize(text), error: null };
  } catch (e) {
    return { value: [], error: toDiagnosticError(e, 'Tokenizer') };
  }
}

function safeParse(text) {
  try {
    return { program: parse(text), error: null };
  } catch (e) {
    return { program: null, error: toDiagnosticError(e, 'Parser') };
  }
}

function toDiagnosticError(e, source) {
  if (e instanceof LangSyntaxError) {
    return { message: e.message.replace(/ at \d+:\d+$/, ''), line: e.line ?? 1, column: e.column ?? 1, source };
  }
  return { message: e.message ?? String(e), line: 1, column: 1, source };
}
