import { SemanticTokensBuilder, type SemanticTokensLegend } from "vscode-languageserver/node.js";
import type { ModuleBindingKind } from "tera/frontend";
import type { AnalyzedDocument, AnalyzedToken } from "../analyzer/index.ts";
import { importsIn } from "../analyzer/import-syntax.ts";
import { pathOfUri } from "../analyzer/paths.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const TOKEN_TYPES = ["namespace", "class", "enumMember", "parameter", "variable", "function", "method", "type"] as const;

type TokenTypeName = (typeof TOKEN_TYPES)[number];

const legend: SemanticTokensLegend = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: ["declaration"],
};

const TYPE_BY_KIND: Record<string, TokenTypeName> = {
  namespace: "namespace",
  model: "class",
  module: "class",
  sequential: "class",
  optimizer: "class",
  scheduler: "class",
  metric: "class",
  callback: "class",
  logger: "class",
  trainer: "class",
  ml_model: "class",
  ml_transform: "class",
  ml_cluster: "class",
  ml_split: "class",
  grid_search: "class",
  function: "function",
  global: "function",
  step: "method",
  factory: "function",
  data: "function",
  linalg: "function",
  ml_metric: "function",
  ml_function: "function",
  numeric_dist: "function",
  numeric_func: "function",
  numeric_transform: "function",
  numeric_stats_test: "function",
  numeric_timeseries: "function",
  numeric_array_op: "function",
  numeric_random: "function",
  quant: "function",
  parameter: "parameter",
  variable: "variable",
  field: "variable",
  method: "method",
  property: "variable",
  device: "enumMember",
  dtype: "enumMember",
  constant: "enumMember",
};

const TYPE_BY_BINDING: Record<ModuleBindingKind, TokenTypeName> = {
  function: "function",
  class: "class",
  model: "class",
  interface: "type",
  type: "type",
  value: "variable",
  module: "namespace",
};

export default defineProvider({
  id: "semanticTokens",
  legend,
  register(connection, context) {
    connection.languages.semanticTokens.on((params) => {
      const document = context.analyzer.get(params.textDocument.uri);
      if (!document) return { data: [] };
      return build(document, context, params.textDocument.uri);
    });
  },
});

function build(document: AnalyzedDocument, context: ProviderContext, uri: string) {
  const typeIndex = new Map(legend.tokenTypes.map((name, index) => [name, index]));
  const builder = new SemanticTokensBuilder();
  const symbolByName = new Map(document.symbols.flat.map((symbol) => [symbol.name, symbol]));
  const types = new Set(context.languageData.types);
  const imported = importedTypes(context, uri, document);
  const paths = modulePathTokens(document);

  let callDepth = 0;
  for (let i = 0; i < document.tokens.length; i++) {
    const token = document.tokens[i];
    if (token.value === "(" || token.value === "[") callDepth++;
    else if (token.value === ")" || token.value === "]") callDepth = Math.max(0, callDepth - 1);
    if (token.type !== "identifier") continue;

    const tokenType = paths.has(`${token.line}:${token.column}`)
      ? "namespace"
      : resolve(document.tokens, i, callDepth, context, symbolByName, types, imported);
    if (!tokenType) continue;

    builder.push(
      Math.max(0, token.line - 1),
      Math.max(0, token.column - 1),
      token.value.length,
      typeIndex.get(tokenType)!,
      0,
    );
  }
  return builder.build();
}

function importedTypes(
  context: ProviderContext,
  uri: string,
  document: AnalyzedDocument,
): Map<string, TokenTypeName> {
  const entryPath = pathOfUri(uri);
  if (entryPath === null) return new Map();
  const types = new Map<string, TokenTypeName>();
  for (const name of context.modules.importedNames(entryPath, document.lines)) {
    types.set(name.local, name.namespace ? "namespace" : TYPE_BY_BINDING[name.kind]);
  }
  return types;
}

function modulePathTokens(document: AnalyzedDocument): Set<string> {
  const positions = new Set<string>();
  for (const syntax of importsIn(document.lines)) {
    for (const token of syntax.path) positions.add(`${token.line + 1}:${token.start + 1}`);
  }
  return positions;
}

function resolve(
  tokens: AnalyzedToken[],
  index: number,
  callDepth: number,
  context: ProviderContext,
  symbolByName: Map<string, { kind: string }>,
  types: Set<string>,
  imported: Map<string, TokenTypeName>,
): TokenTypeName | null {
  if (callDepth > 0 && tokens[index + 1]?.value === "=") return "parameter";
  if (tokens[index - 1]?.value === ".") {
    const next = tokens[index + 1]?.value;
    if (next === "(") return "method";
    if (next === "<" && genericCallAhead(tokens, index + 1)) return "method";
    return null;
  }

  const name = tokens[index].value;
  const importedType = imported.get(name);
  if (importedType !== undefined) return importedType;

  const builtin = context.types.builtin(name);
  if (builtin) {
    const builtinType = TYPE_BY_KIND[builtin.kind] ?? null;
    if (builtin.returns === name && builtinType !== "namespace") return "class";
    if (types.has(name)) return "type";
    return builtinType;
  }

  if (types.has(name)) return "type";

  const symbol = symbolByName.get(name);
  return symbol ? TYPE_BY_KIND[symbol.kind] ?? null : null;
}

function genericCallAhead(tokens: AnalyzedToken[], start: number): boolean {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (value === "<") depth++;
    else if (value === ">") depth--;
    else if (value === ">>") depth -= 2;
    else if (value === ">>>") depth -= 3;
    else continue;
    if (depth <= 0) return tokens[i + 1]?.value === "(";
  }
  return false;
}
