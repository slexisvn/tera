import { SemanticTokensBuilder, type SemanticTokensLegend } from "vscode-languageserver/node.js";
import type { ModuleBindingKind } from "tera/frontend";
import type { AnalyzedDocument, AnalyzedToken } from "../analyzer/index.ts";
import { importsIn } from "../analyzer/import-syntax.ts";
import { pathOfUri } from "../analyzer/paths.ts";
import { symbolsFor } from "../language/members.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

export const TOKEN_TYPES = ["namespace", "class", "enumMember", "parameter", "variable", "function", "method", "type"] as const;

type TokenTypeName = (typeof TOKEN_TYPES)[number];

export const semanticTokenLegend: SemanticTokensLegend = {
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

const MODEL_HOOKS = new Set(["forward", "train", "validate", "optimizer"]);

export default defineProvider({
  id: "semanticTokens",
  legend: semanticTokenLegend,
  register(connection, context) {
    connection.languages.semanticTokens.on((params) => {
      const document = context.analyzer.get(params.textDocument.uri);
      if (!document) return { data: [] };
      return buildSemanticTokens(document, context, params.textDocument.uri);
    });
  },
});

export function buildSemanticTokens(document: AnalyzedDocument, context: ProviderContext, uri: string) {
  const typeIndex = new Map(semanticTokenLegend.tokenTypes.map((name, index) => [name, index]));
  const builder = new SemanticTokensBuilder();
  const types = new Set(context.languageData.types);
  const imported = importedTypes(context, uri, document);
  const paths = modulePathTokens(document);
  const contextual = contextualNameTypes(document);
  const symbols = symbolsFor(context, uri, document);

  let callDepth = 0;
  for (let i = 0; i < document.tokens.length; i++) {
    const token = document.tokens[i];
    if (token.value === "(" || token.value === "[") callDepth++;
    else if (token.value === ")" || token.value === "]") callDepth = Math.max(0, callDepth - 1);
    if (token.type !== "identifier" && !contextual.has(positionKey(token))) continue;

    const tokenType = paths.has(`${token.line}:${token.column}`)
      ? "namespace"
      : resolve(document, i, callDepth, context, symbols, types, imported, contextual);
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
  document: AnalyzedDocument,
  index: number,
  callDepth: number,
  context: ProviderContext,
  symbols: AnalyzedDocument["symbols"],
  types: Set<string>,
  imported: Map<string, TokenTypeName>,
  contextual: ReadonlyMap<string, TokenTypeName>,
): TokenTypeName | null {
  const tokens = document.tokens;
  if (callDepth > 0 && tokens[index + 1]?.value === "=") return "parameter";
  if (tokens[index - 1]?.value === ".") {
    const next = tokens[index + 1]?.value;
    if (next === "(") return "method";
    if (next === "<" && genericCallAhead(tokens, index + 1)) return "method";
    return null;
  }

  const name = tokens[index].value;
  const contextualType = contextual.get(positionKey(tokens[index]));
  if (contextualType !== undefined) return contextualType;

  const hookType = modelHookType(tokens, index);
  if (hookType) return hookType;

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

  const symbol = symbols.resolve(name, {
    line: Math.max(0, tokens[index].line - 1),
    character: Math.max(0, tokens[index].column - 1),
  });
  return symbol ? TYPE_BY_KIND[symbol.kind] ?? null : null;
}

type DelimiterFrame = { open: "{" | "(" | "["; expectKey: boolean };

function contextualNameTypes(document: AnalyzedDocument): ReadonlyMap<string, TokenTypeName> {
  const types = new Map<string, TokenTypeName>();
  collectInterfaceMemberTypes(document.lines, types);
  collectLiteralKeyTypes(document.tokens, types);
  return types;
}

function collectInterfaceMemberTypes(lines: readonly string[], types: Map<string, TokenTypeName>): void {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const match = /^([ \t]*)([A-Za-z_$][\w$]*)\s*(?::|\()/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const header = nearestOuterHeader(lines, index, indent);
    if (header === null || !/^interface\b/.test(header)) continue;
    const rest = line.slice(indent + match[2].length);
    types.set(`${index + 1}:${indent + 1}`, /^(?:\s*\(|\s*:\s*(?:\(|fn\b))/.test(rest) ? "method" : "variable");
  }
}

function nearestOuterHeader(lines: readonly string[], lineIndex: number, indent: number): string | null {
  for (let index = lineIndex - 1; index >= 0; index--) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parentIndent = line.length - line.trimStart().length;
    if (parentIndent < indent) return trimmed;
  }
  return null;
}

function collectLiteralKeyTypes(tokens: readonly AnalyzedToken[], types: Map<string, TokenTypeName>): void {
  const stack: DelimiterFrame[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === "{" || token.value === "(" || token.value === "[") {
      stack.push({ open: token.value, expectKey: token.value === "{" });
      continue;
    }
    if (token.value === "}" || token.value === ")" || token.value === "]") {
      popDelimiter(stack, token.value);
      continue;
    }
    const frame = stack.at(-1);
    if (token.value === ",") {
      if (frame?.open === "{") frame.expectKey = true;
      continue;
    }
    if (token.value === ":") {
      if (frame?.open === "{") frame.expectKey = false;
      continue;
    }
    if ((token.type === "identifier" || token.type === "keyword") && frame?.open === "{" && frame.expectKey && hasLiteralKeyDelimiter(tokens, index)) {
      const key = positionKey(token);
      if (!types.has(key)) types.set(key, "variable");
    }
  }
}

function hasLiteralKeyDelimiter(tokens: readonly AnalyzedToken[], index: number): boolean {
  const next = tokens[index + 1];
  if (next?.value === ":") return true;
  return next?.value === "?" && tokens[index + 2]?.value === ":";
}

function popDelimiter(stack: DelimiterFrame[], close: string): void {
  const open = close === "}" ? "{" : close === ")" ? "(" : "[";
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame?.open === open) return;
  }
}

function positionKey(token: Pick<AnalyzedToken, "line" | "column">): string {
  return `${token.line}:${token.column}`;
}

function modelHookType(tokens: AnalyzedToken[], index: number): TokenTypeName | null {
  const token = tokens[index];
  if (!MODEL_HOOKS.has(token.value)) return null;
  if (tokens[index - 1]?.value === ".") return null;

  const next = tokens[index + 1];
  if (next?.line !== token.line) return null;
  if (next.value === ":") return "function";
  if (next.value !== "(") return null;

  let depth = 0;
  for (let i = index + 1; i < tokens.length; i++) {
    const current = tokens[i];
    if (current.line !== token.line) return null;
    if (current.value === "(" || current.value === "[" || current.value === "{") depth++;
    else if (current.value === ")" || current.value === "]" || current.value === "}") depth = Math.max(0, depth - 1);
    else if (current.value === ":" && depth === 0) return "function";
  }
  return null;
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
