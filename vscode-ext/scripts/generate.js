import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractKeywords, classifyKeywords } from './extractors/keywords.js';
import { extractOperators } from './extractors/operators.js';
import { extractBuiltins } from './extractors/builtins.js';
import { extractBuiltinDocs } from './extractors/builtin_docs.js';
import { buildGrammar } from './emitters/grammar.js';
import { buildLanguageData } from './emitters/language_data.js';
import { buildSnippets } from './emitters/snippets.js';
import { TYPE_NAMES } from '../../src/typechecker.js';
import { builtinEffect, methodEffect } from '../../src/effects.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(EXT_ROOT, '..');

const SOURCES = {
  parser: join(REPO_ROOT, 'src/parser.js'),
  tokenizer: join(REPO_ROOT, 'src/tokenizer.js'),
  builtins: [
    join(REPO_ROOT, 'src/builtins.js'),
    join(REPO_ROOT, 'src/builtins-dataframe.js'),
    join(REPO_ROOT, 'src/builtins-quant.js'),
    join(REPO_ROOT, 'src/builtins-ml.js'),
    join(REPO_ROOT, 'src/builtins-numeric.js'),
  ],
  builtinDocs: join(EXT_ROOT, 'data/builtin-docs.md'),
};

const OUTPUTS = {
  grammar: join(EXT_ROOT, 'syntaxes/tera.tmLanguage.json'),
  languageData: join(EXT_ROOT, 'language-data.json'),
  snippets: join(EXT_ROOT, 'snippets/tera.json'),
  vendorDir: join(EXT_ROOT, 'server/vendor'),
};

const VENDORED_FILES = ['tokenizer.js', 'parser.js', 'types.js', 'typechecker.js', 'method_returns.js', 'effects.js', 'symbol_table.js'];

export function generate(sources = SOURCES, outputs = OUTPUTS) {
  const baseKeywords = extractKeywords(sources.parser);
  const keywordGroups = classifyKeywords(baseKeywords);
  const operators = extractOperators(sources.tokenizer);
  const builtins = extractBuiltins(sources.builtins);
  const docs = extractBuiltinDocs(sources.builtinDocs);

  const runtimeNames = new Set(builtins.map(b => b.name));
  keywordGroups.type = TYPE_NAMES.filter(n => !baseKeywords.includes(n) && !runtimeNames.has(n)).sort();
  const keywords = [...new Set([...baseKeywords, ...keywordGroups.type])].sort();

  const enriched = builtins.map(b => mergeDoc(b, docs.builtins.get(b.name), docs.kindTemplates));
  const undocumented = enriched.filter(b => !b.documented).map(b => b.name);

  const docOnly = [];
  for (const [name, doc] of docs.builtins) {
    if (runtimeNames.has(name)) continue;
    docOnly.push(buildDocOnlyBuiltin(doc, docs.kindTemplates));
  }
  const allBuiltins = [...enriched, ...docOnly];

  const pseudoTypes = serializePseudoTypes(docs.pseudoTypes);

  const grammar = buildGrammar({ keywordGroups, operators, builtins: allBuiltins });
  const languageData = buildLanguageData({ keywords, keywordGroups, operators, builtins: allBuiltins, pseudoTypes });
  const snippets = buildSnippets({ builtins: allBuiltins });

  ensureDir(dirname(outputs.grammar));
  ensureDir(dirname(outputs.snippets));
  writeJson(outputs.grammar, grammar);
  writeJson(outputs.languageData, languageData);
  writeJson(outputs.snippets, snippets);
  if (outputs.vendorDir) vendorSources(join(REPO_ROOT, 'src'), outputs.vendorDir);

  return { keywords, operators, builtins: enriched, undocumented };
}

const RETURNS_BY_KIND = {
  factory: 'Tensor',
  function: 'Tensor',
  reduction: 'Tensor',
  shape: 'Tensor',
  autograd: 'Tensor',
  module: 'Module',
  sequential: 'Module',
  optimizer: 'Optimizer',
  scheduler: 'Scheduler',
  trainer: 'Trainer',
  metric: 'Metric',
  callback: 'Callback',
  logger: 'Logger',
  numeric_stats_test: 'Record',
  numeric_timeseries: 'Tensor',
  numeric_array_op: 'Tensor',
  numeric_random: 'Tensor',
};

const RETURNS_OVERRIDE = {
  shape: 'int[]',
  dtype: 'string',
  len: 'int',
  range: 'int[]',
  print: null,
  trace: 'string',
  graph: 'string',
  compile: null,
  cat: 'Tensor',
  stack: 'Tensor',
  where: 'Tensor',
  read_text: 'string',
  Tokenizer: 'Tokenizer',
  load_tokenizer: 'Tokenizer',
  load_csv: 'DataFrame',
  DataFrame: 'DataFrame',
  col: 'Column',
  lit: 'Column',
  expr: 'Column',
  avg: 'Column',
  count: 'Column',
  countStar: 'Column',
  train_test_split: null,
  cross_val_score: null,
  cholesky: 'Tensor',
  solve: 'Tensor',
  lstsq: 'Tensor',
  inv: 'Tensor',
  pinv: 'Tensor',
  cov: 'Tensor',
  det: 'float',
  svd: null,
  eigh: null,
  r2_score: 'float',
  mean_squared_error: 'float',
  mean_absolute_error: 'float',
  accuracy_score: 'float',
  confusion_matrix: null,
  normal_cdf: 'Tensor',
  normal_ppf: 'Tensor',
  normal_pdf: 'Tensor',
  t_cdf: 'Tensor',
  t_ppf: 'Tensor',
  t_pdf: 'Tensor',
  chi2_cdf: 'Tensor',
  chi2_ppf: 'Tensor',
  chi2_pdf: 'Tensor',
  f_cdf: 'Tensor',
  f_ppf: 'Tensor',
  f_pdf: 'Tensor',
  erf: 'Tensor',
  erfc: 'Tensor',
  lgamma: 'Tensor',
  gamma: 'Tensor',
  fft: 'Tensor',
  ifft: 'Tensor',
  qr: null,
  linear_interp: null,
  cubic_spline: null,
  ljung_box: 'Record',
  durbin_watson: 'float',
};

const ML_SELF_RETURN_KINDS = new Set(['ml_model', 'ml_transform', 'ml_cluster', 'ml_split', 'grid_search']);

const DEFAULT_DOC_BUILTIN_KIND = 'function';

function inferReturns(builtin) {
  if (builtin.name in RETURNS_OVERRIDE) return RETURNS_OVERRIDE[builtin.name];
  // Modules construct an instance of their own nominal type (Embedding(...) -> Embedding),
  // not the generic `Module`, so variables bound to them infer precisely.
  if (builtin.kind === 'module' || builtin.kind === 'sequential') return builtin.name;
  // ml estimators/transformers/splitters construct their own nominal type so `.fit()`/`.predict()`
  // resolve against the object's methods.
  if (ML_SELF_RETURN_KINDS.has(builtin.kind)) return builtin.name;
  return RETURNS_BY_KIND[builtin.kind] ?? null;
}

function mergeDoc(builtin, doc, kindTemplates) {
  const template = kindTemplates.get(builtin.kind);
  const returns = inferReturns(builtin);
  if (!doc) {
    return {
      ...builtin,
      signature: null,
      description: null,
      methods: withMethodEffects(builtin.name, template ? [...template.methods] : []),
      returns,
      effect: builtinEffect(builtin.name),
      documented: false,
    };
  }
  const ownMethodNames = new Set((doc.methods ?? []).map(m => m.name));
  const inherited = (template?.methods ?? []).filter(m => !ownMethodNames.has(m.name));
  // A doc-declared `{kind}` annotation overrides the kind inferred from source.
  const kind = doc.kind ?? builtin.kind;
  return {
    ...builtin,
    kind,
    description: doc.description,
    signature: doc.params === null ? null : { params: doc.params },
    methods: withMethodEffects(builtin.name, [...(doc.methods ?? []), ...inherited]),
    returns,
    effect: doc.effect ?? builtinEffect(builtin.name),
    documented: true,
  };
}

function buildDocOnlyBuiltin(doc, kindTemplates) {
  const kind = doc.kind ?? DEFAULT_DOC_BUILTIN_KIND;
  const template = kindTemplates.get(kind);
  const ownMethodNames = new Set((doc.methods ?? []).map(m => m.name));
  const inherited = (template?.methods ?? []).filter(m => !ownMethodNames.has(m.name));
  return {
    name: doc.name,
    kind,
    description: doc.description,
    signature: doc.params === null ? null : { params: doc.params },
    methods: withMethodEffects(doc.name, [...(doc.methods ?? []), ...inherited]),
    returns: inferReturns({ name: doc.name, kind }),
    effect: doc.effect ?? builtinEffect(doc.name),
    documented: true,
  };
}

function serializePseudoTypes(map) {
  const out = {};
  for (const [name, entry] of map) out[name] = { methods: withMethodEffects(name, entry.methods) };
  return out;
}

function withMethodEffects(typeName, methods = []) {
  return methods.map(method => ({ ...method, effect: method.effect ?? methodEffect(typeName, method.name) }));
}

function vendorSources(srcDir, destDir) {
  ensureDir(destDir);
  for (const file of VENDORED_FILES) copyFileSync(join(srcDir, file), join(destDir, file));
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const isEntry = process.argv[1] && process.argv[1].endsWith('generate.js');
if (isEntry) {
  const result = generate();
  process.stdout.write(`Generated: ${result.builtins.length} builtins, ${result.keywords.length} keywords\n`);
  if (result.undocumented.length) {
    process.stdout.write(`Undocumented (${result.undocumented.length}): ${result.undocumented.join(', ')}\n`);
  }
}
