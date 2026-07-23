import type { Builtin, KeywordGroup, Operators } from "../../src/shared/language-data.ts";

type Pattern = Record<string, unknown>;

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";

const SCOPE_BY_KEYWORD_GROUP: Record<KeywordGroup, string> = {
  declaration: "keyword.other.declaration.tera",
  control: "keyword.control.tera",
  operator: "keyword.operator.word.tera",
  constant: "constant.language.tera",
  variable: "variable.language.tera",
};

const SCOPE_BY_BUILTIN_KIND: Record<string, string> = {
  constant: "constant.language.tera",
  namespace: "support.class.namespace.tera",
  global: "support.function.tera",
  step: "support.function.tera",
  module: "support.class.nn-module.tera",
  optimizer: "support.class.optimizer.tera",
  scheduler: "support.class.scheduler.tera",
  callback: "support.class.callback.tera",
  logger: "support.class.logger.tera",
  metric: "support.class.metric.tera",
  trainer: "support.class.trainer.tera",
  sequential: "support.class.sequential.tera",
  factory: "support.function.factory.tera",
  reduction: "support.function.reduction.tera",
  data: "support.function.data.tera",
  autograd: "support.function.autograd.tera",
  shape: "support.function.shape.tera",
  utility: "support.function.utility.tera",
  function: "support.function.tera",
};

const DEFAULT_BUILTIN_SCOPE = "support.function.tera";

const REGEX_BODY = "/(?![/*])(?:[^/\\\\\\[\\n]|\\\\.|\\[(?:[^\\]\\\\\\n]|\\\\.)*\\])+/[gimsuyd]*";

const REGEX_CONTEXTS: Array<{ prefix: string; scope: string }> = [
  { prefix: "(=|==|===|!=|!==|=>|\\+=|-=|\\*=|/=|%=)", scope: "keyword.operator.tera" },
  { prefix: "([(\\[,:])", scope: "punctuation.separator.tera" },
  { prefix: "\\b(return|and|or|not|in|of|typeof|await|yield)\\b", scope: "keyword.control.tera" },
];

export function buildGrammar(config: {
  keywordGroups: Record<KeywordGroup, string[]>;
  types: string[];
  operators: Operators;
  builtins: Builtin[];
}) {
  return {
    $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    name: "Tera",
    scopeName: "source.tera",
    fileTypes: ["tera"],
    patterns: [
      { include: "#comments" },
      { include: "#strings" },
      { include: "#regex" },
      { include: "#numbers" },
      { include: "#declarations" },
      { include: "#annotations" },
      { include: "#keywords" },
      { include: "#types" },
      { include: "#builtins" },
      { include: "#calls" },
      { include: "#operators" },
      { include: "#identifiers" },
    ],
    repository: {
      comments: { patterns: commentPatterns() },
      strings: { patterns: stringPatterns() },
      regex: { patterns: regexPatterns() },
      numbers: { patterns: numberPatterns() },
      declarations: { patterns: declarationPatterns(config.keywordGroups) },
      annotations: { patterns: annotationPatterns(config.keywordGroups) },
      keywords: { patterns: keywordPatterns(config.keywordGroups) },
      types: { patterns: typePatterns(config.types) },
      builtins: { patterns: builtinPatterns(config.builtins) },
      calls: { patterns: callPatterns() },
      operators: { patterns: operatorPatterns(config.operators) },
      identifiers: { patterns: identifierPatterns() },
    },
  };
}

function commentPatterns(): Pattern[] {
  return [
    { name: "comment.line.number-sign.tera", match: "#.*$" },
    { name: "comment.line.double-slash.tera", match: "//.*$" },
    { name: "comment.block.tera", begin: "/\\*", end: "\\*/" },
  ];
}

function stringPatterns(): Pattern[] {
  const escape = { name: "constant.character.escape.tera", match: "\\\\." };
  return [
    {
      name: "string.quoted.double.tera",
      begin: '"',
      end: '"',
      patterns: [escape],
    },
    {
      name: "string.quoted.single.tera",
      begin: "'",
      end: "'",
      patterns: [escape],
    },
    {
      name: "string.template.tera",
      begin: "`",
      end: "`",
      patterns: [
        escape,
        {
          name: "meta.template.expression.tera",
          begin: "\\$\\{",
          end: "\\}",
          beginCaptures: { 0: { name: "punctuation.definition.template-expression.begin.tera" } },
          endCaptures: { 0: { name: "punctuation.definition.template-expression.end.tera" } },
          patterns: [{ include: "$self" }],
        },
      ],
    },
  ];
}

function regexPatterns(): Pattern[] {
  return REGEX_CONTEXTS.map(({ prefix, scope }) => ({
    match: `${prefix}\\s*(${REGEX_BODY})`,
    captures: {
      1: { name: scope },
      2: { name: "string.regexp.tera" },
    },
  }));
}

function numberPatterns(): Pattern[] {
  return [
    { name: "constant.numeric.hex.tera", match: "\\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\\b" },
    { name: "constant.numeric.binary.tera", match: "\\b0[bB][01][01_]*\\b" },
    { name: "constant.numeric.octal.tera", match: "\\b0[oO][0-7][0-7_]*\\b" },
    { name: "constant.numeric.decimal.tera", match: "\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?\\b" },
    { name: "constant.numeric.decimal.tera", match: "(?<![\\w.])\\.\\d[\\d_]*(?:[eE][+-]?\\d+)?\\b" },
  ];
}

function declarationPatterns(groups: Record<KeywordGroup, string[]>): Pattern[] {
  const declarations = new Set(groups.declaration);
  const patterns: Pattern[] = [];

  const callable = ["fn"].filter((k) => declarations.has(k));
  if (callable.length) {
    patterns.push({
      match: `\\b(${callable.join("|")})\\s+(${IDENT})`,
      captures: {
        1: { name: "keyword.other.declaration.tera" },
        2: { name: "entity.name.function.tera" },
      },
    });
  }

  const typeLike = ["model", "class"].filter((k) => declarations.has(k));
  if (typeLike.length) {
    patterns.push({
      match: `\\b(${typeLike.join("|")})\\s+(${IDENT})`,
      captures: {
        1: { name: "keyword.other.declaration.tera" },
        2: { name: "entity.name.type.tera" },
      },
    });
  }

  if (declarations.has("extends")) {
    patterns.push({
      match: `\\b(extends)\\s+(${IDENT})`,
      captures: {
        1: { name: "keyword.other.declaration.tera" },
        2: { name: "entity.other.inherited-class.tera" },
      },
    });
  }

  return patterns;
}

function annotationPatterns(groups: Record<KeywordGroup, string[]>): Pattern[] {
  const keywords = Object.values(groups).flat().sort(byLengthDesc).join("|");
  return [
    {
      match: `(->)\\s*(?!(?:${keywords})\\b)(${IDENT})`,
      captures: {
        1: { name: "keyword.operator.arrow.tera" },
        2: { name: "entity.name.type.tera" },
      },
    },
  ];
}

function keywordPatterns(groups: Record<KeywordGroup, string[]>): Pattern[] {
  const patterns: Pattern[] = [];
  for (const [group, names] of Object.entries(groups) as Array<[KeywordGroup, string[]]>) {
    if (!names.length) continue;
    patterns.push({
      name: SCOPE_BY_KEYWORD_GROUP[group],
      match: `\\b(?:${[...names].sort(byLengthDesc).join("|")})\\b`,
    });
  }
  return patterns;
}

function typePatterns(types: string[]): Pattern[] {
  if (!types.length) return [];
  return [{
    name: "storage.type.tera",
    match: `\\b(?:${[...types].sort(byLengthDesc).map(escapeRegex).join("|")})\\b`,
  }];
}

function builtinPatterns(builtins: Builtin[]): Pattern[] {
  const byKind = new Map<string, string[]>();
  for (const builtin of builtins) {
    const names = byKind.get(builtin.kind) ?? [];
    names.push(builtin.name);
    byKind.set(builtin.kind, names);
  }

  const patterns: Pattern[] = [];
  for (const [kind, names] of byKind) {
    patterns.push({
      name: SCOPE_BY_BUILTIN_KIND[kind] ?? DEFAULT_BUILTIN_SCOPE,
      match: `\\b(?:${[...names].sort(byLengthDesc).map(escapeRegex).join("|")})\\b`,
    });
  }
  return patterns;
}

function callPatterns(): Pattern[] {
  return [
    {
      match: `(?<=\\.)\\s*(${IDENT})\\s*(?=\\()`,
      captures: { 1: { name: "entity.name.function.member.tera" } },
    },
    {
      match: `\\b(${IDENT})\\s*(?=\\()`,
      captures: { 1: { name: "entity.name.function.call.tera" } },
    },
    {
      match: `(?<=\\.)\\s*(${IDENT})`,
      captures: { 1: { name: "variable.other.property.tera" } },
    },
  ];
}

function operatorPatterns(operators: Operators): Pattern[] {
  const brackets = new Set(["(", ")", "[", "]", "{", "}"]);
  const separators = new Set([",", ".", ";"]);

  const compound = [...operators.threeChar, ...operators.twoChar];
  const single = operators.oneChar.filter((op) => !brackets.has(op) && !separators.has(op));

  const patterns: Pattern[] = [];
  if (compound.length) {
    patterns.push({
      name: "keyword.operator.compound.tera",
      match: compound.sort(byLengthDesc).map(escapeRegex).join("|"),
    });
  }
  if (single.length) {
    patterns.push({
      name: "keyword.operator.tera",
      match: single.map(escapeRegex).join("|"),
    });
  }
  patterns.push({ name: "punctuation.separator.tera", match: "[,.;]" });
  patterns.push({ name: "punctuation.section.brackets.tera", match: "[\\[\\](){}]" });
  return patterns;
}

function identifierPatterns(): Pattern[] {
  return [{ name: "variable.other.tera", match: `\\b${IDENT}\\b` }];
}

function byLengthDesc(a: string, b: string): number {
  return b.length - a.length || a.localeCompare(b);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
