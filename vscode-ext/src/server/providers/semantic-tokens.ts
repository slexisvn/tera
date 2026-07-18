import { SemanticTokensBuilder, type SemanticTokensLegend } from "vscode-languageserver/node.js";
import type { AnalyzedDocument, AnalyzedToken } from "../analyzer/index.ts";
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
  device: "enumMember",
  dtype: "enumMember",
  constant: "enumMember",
};

export default defineProvider({
  id: "semanticTokens",
  legend,
  register(connection, context) {
    connection.languages.semanticTokens.on((params) => {
      const document = context.analyzer.get(params.textDocument.uri);
      if (!document) return { data: [] };
      return build(document, context);
    });
  },
});

function build(document: AnalyzedDocument, context: ProviderContext) {
  const typeIndex = new Map(legend.tokenTypes.map((name, index) => [name, index]));
  const builder = new SemanticTokensBuilder();
  const symbolByName = new Map(document.symbols.flat.map((symbol) => [symbol.name, symbol]));
  const types = new Set(context.languageData.types);

  let callDepth = 0;
  for (let i = 0; i < document.tokens.length; i++) {
    const token = document.tokens[i];
    if (token.value === "(" || token.value === "[") callDepth++;
    else if (token.value === ")" || token.value === "]") callDepth = Math.max(0, callDepth - 1);
    if (token.type !== "identifier") continue;

    const tokenType = resolve(document.tokens, i, callDepth, context, symbolByName, types);
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

function resolve(
  tokens: AnalyzedToken[],
  index: number,
  callDepth: number,
  context: ProviderContext,
  symbolByName: Map<string, { kind: string }>,
  types: Set<string>,
): TokenTypeName | null {
  if (callDepth > 0 && tokens[index + 1]?.value === "=") return "parameter";
  if (tokens[index - 1]?.value === ".") return tokens[index + 1]?.value === "(" ? "method" : null;

  const name = tokens[index].value;
  if (types.has(name)) return "type";

  const builtin = context.types.builtin(name);
  if (builtin) return TYPE_BY_KIND[builtin.kind] ?? null;

  const symbol = symbolByName.get(name);
  return symbol ? TYPE_BY_KIND[symbol.kind] ?? null : null;
}
