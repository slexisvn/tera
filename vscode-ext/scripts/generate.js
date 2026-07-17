import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrammar } from './emitters/grammar.js';
import { buildLanguageData } from './emitters/language_data.js';
import { buildSnippets } from './emitters/snippets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');

const KEYWORD_GROUPS = {
  declaration: ['fn', 'model', 'class', 'type', 'interface', 'extends', 'constructor'],
  control: ['if', 'else', 'for', 'while', 'try', 'catch', 'finally', 'return', 'throw', 'break', 'continue', 'async', 'await', 'yield'],
  operator: ['and', 'or', 'not', 'is', 'in', 'instanceof', 'typeof'],
  constant: ['true', 'false', 'null', 'undefined'],
  type: ['any', 'unknown', 'number', 'int', 'float', 'string', 'bool', 'boolean', 'Tensor', 'DataFrame', 'Map', 'Set', 'Array', 'Object'],
};

const OPERATORS = {
  threeChar: ['===', '!==', '>>>', '**=', '&&=', '||=', '??='],
  twoChar: ['=>', '->', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>'],
  oneChar: ['+', '-', '*', '/', '%', '@', '<', '>', '=', '!', '&', '|', '^', '~', '?', ':', '.', ',', '(', ')', '[', ']'],
};

const OUTPUTS = {
  grammar: join(EXT_ROOT, 'syntaxes/tera.tmLanguage.json'),
  languageData: join(EXT_ROOT, 'language-data.json'),
  snippets: join(EXT_ROOT, 'snippets/tera.json'),
};

export function generate(outputs = OUTPUTS) {
  const seed = readJson(outputs.languageData, { builtins: [], pseudoTypes: {} });
  const builtins = normalizeBuiltins(seed.builtins ?? []);
  const pseudoTypes = normalizePseudoTypes(seed.pseudoTypes ?? {});
  const keywords = [...new Set(Object.values(KEYWORD_GROUPS).flat())].sort();
  const grammar = buildGrammar({ keywordGroups: KEYWORD_GROUPS, operators: OPERATORS, builtins });
  const languageData = buildLanguageData({ keywords, keywordGroups: KEYWORD_GROUPS, operators: OPERATORS, builtins, pseudoTypes });
  const snippets = buildSnippets({ builtins });

  ensureDir(dirname(outputs.grammar));
  ensureDir(dirname(outputs.languageData));
  ensureDir(dirname(outputs.snippets));
  writeJson(outputs.grammar, grammar);
  writeJson(outputs.languageData, languageData);
  writeJson(outputs.snippets, snippets);

  return { keywords, operators: OPERATORS, builtins, undocumented: [] };
}

function normalizeBuiltins(builtins) {
  return builtins.map(builtin => ({
    ...builtin,
    kind: builtin.kind ?? 'function',
    signature: builtin.signature ? { params: builtin.signature.params ?? [] } : null,
    methods: (builtin.methods ?? []).map(method => ({
      ...method,
      params: method.signature?.params ?? method.params ?? [],
    })),
  }));
}

function normalizePseudoTypes(pseudoTypes) {
  const out = {};
  for (const [name, methods] of Object.entries(pseudoTypes)) {
    out[name] = {
      methods: (methods ?? []).map(method => ({
        ...method,
        params: method.signature?.params ?? method.params ?? [],
      })),
    };
  }
  return out;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const result = generate();
  console.log(`Generated ${result.keywords.length} keywords and ${result.builtins.length} builtins.`);
}
