const SCOPE_BY_KEYWORD_GROUP = {
  declaration: 'keyword.other.declaration.tera',
  control: 'keyword.control.tera',
  operator: 'keyword.operator.logical.tera',
  constant: 'constant.language.tera',
  type: 'storage.type.tera',
};

const SCOPE_BY_BUILTIN_KIND = {
  device: 'constant.language.device.tera',
  dtype: 'constant.language.dtype.tera',
  module: 'support.class.nn-module.tera',
  factory: 'support.function.factory.tera',
  function: 'support.function.tera',
  reduction: 'support.function.reduction.tera',
  optimizer: 'support.class.optimizer.tera',
  scheduler: 'support.class.scheduler.tera',
  callback: 'support.class.callback.tera',
  logger: 'support.class.logger.tera',
  metric: 'support.class.metric.tera',
  trainer: 'support.class.trainer.tera',
  data: 'support.function.data.tera',
  sequential: 'support.class.sequential.tera',
  autograd: 'support.function.autograd.tera',
  shape: 'support.function.shape.tera',
  utility: 'support.function.utility.tera',
  step: 'support.function.tera',
  constant: 'constant.language.tera',
  other: 'support.function.tera',
};

export function buildGrammar({ keywordGroups, operators, builtins }) {
  const repository = {
    comments: {
      patterns: [
        { name: 'comment.line.number-sign.tera', match: '#.*$' },
        { name: 'comment.line.double-slash.tera', match: '//.*$' },
      ],
    },
    strings: {
      patterns: [
        {
          name: 'string.quoted.double.tera',
          begin: '"',
          end: '"',
          patterns: [{ name: 'constant.character.escape.tera', match: '\\\\.' }],
        },
        {
          name: 'string.quoted.single.tera',
          begin: "'",
          end: "'",
          patterns: [{ name: 'constant.character.escape.tera', match: '\\\\.' }],
        },
      ],
    },
    numbers: {
      patterns: [
        { name: 'constant.numeric.tera', match: '\\b\\d+(\\.\\d+)?([eE][+-]?\\d+)?\\b' },
        { name: 'constant.numeric.tera', match: '\\.\\d+([eE][+-]?\\d+)?\\b' },
      ],
    },
    keywords: { patterns: buildKeywordPatterns(keywordGroups) },
    operators: { patterns: buildOperatorPatterns(operators) },
    builtins: { patterns: buildBuiltinPatterns(builtins) },
    declarations: { patterns: buildDeclarationPatterns(keywordGroups) },
    identifiers: {
      patterns: [
        { name: 'variable.other.tera', match: '\\b[A-Za-z_][A-Za-z0-9_]*\\b' },
      ],
    },
  };

  return {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name: 'Tera',
    scopeName: 'source.tera',
    fileTypes: ['tera'],
    patterns: [
      { include: '#comments' },
      { include: '#strings' },
      { include: '#numbers' },
      { include: '#declarations' },
      { include: '#keywords' },
      { include: '#builtins' },
      { include: '#operators' },
      { include: '#identifiers' },
    ],
    repository,
  };
}

function buildKeywordPatterns(groups) {
  const patterns = [];
  for (const [group, names] of Object.entries(groups)) {
    if (!names.length) continue;
    const scope = SCOPE_BY_KEYWORD_GROUP[group];
    if (!scope) continue;
    patterns.push({ name: scope, match: `\\b(?:${names.join('|')})\\b` });
  }
  return patterns;
}

function buildOperatorPatterns({ threeChar, twoChar, oneChar }) {
  const longLiterals = [...threeChar, ...twoChar].map(escapeRegex).join('|');
  const shortLiterals = oneChar.filter(c => !'()[],.'.includes(c)).map(escapeRegex).join('|');
  const patterns = [];
  if (longLiterals) patterns.push({ name: 'keyword.operator.compound.tera', match: longLiterals });
  if (shortLiterals) patterns.push({ name: 'keyword.operator.tera', match: shortLiterals });
  patterns.push({ name: 'punctuation.separator.tera', match: '[,.]' });
  patterns.push({ name: 'punctuation.section.brackets.tera', match: '[\\[\\]()]' });
  return patterns;
}

function buildBuiltinPatterns(builtins) {
  const byKind = new Map();
  for (const b of builtins) {
    if (!byKind.has(b.kind)) byKind.set(b.kind, []);
    byKind.get(b.kind).push(b.name);
  }
  const patterns = [];
  for (const [kind, names] of byKind) {
    const scope = SCOPE_BY_BUILTIN_KIND[kind] ?? SCOPE_BY_BUILTIN_KIND.other;
    patterns.push({ name: scope, match: `\\b(?:${names.map(escapeRegex).join('|')})\\b` });
  }
  return patterns;
}

function buildDeclarationPatterns(groups) {
  const decl = groups.declaration ?? [];
  if (!decl.length) return [];
  const namedDecls = ['model', 'fn'].filter(k => decl.includes(k));
  if (!namedDecls.length) return [];
  return [
    {
      match: `\\b(${namedDecls.join('|')})\\s+([A-Za-z_][A-Za-z0-9_]*)`,
      captures: {
        1: { name: 'keyword.other.declaration.tera' },
        2: { name: 'entity.name.type.tera' },
      },
    },
  ];
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
