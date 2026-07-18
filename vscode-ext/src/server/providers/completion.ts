import {
  CompletionItemKind, InsertTextFormat,
  type CompletionItem, type CompletionList, type CompletionParams,
} from "vscode-languageserver/node.js";
import type { Method, Param } from "../../shared/language-data.ts";
import type { AnalyzedDocument, Position, Scope, TeraSymbol } from "../analyzer/index.ts";
import { buildSnippet } from "../../shared/snippet.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const KIND_BY_SYMBOL: Record<string, CompletionItemKind> = {
  model: CompletionItemKind.Class,
  module: CompletionItemKind.Class,
  function: CompletionItemKind.Function,
  parameter: CompletionItemKind.Variable,
  variable: CompletionItemKind.Variable,
  field: CompletionItemKind.Field,
};

const KIND_BY_BUILTIN: Record<string, CompletionItemKind> = {
  namespace: CompletionItemKind.Module,
  module: CompletionItemKind.Class,
  sequential: CompletionItemKind.Class,
  optimizer: CompletionItemKind.Class,
  scheduler: CompletionItemKind.Class,
  callback: CompletionItemKind.Class,
  logger: CompletionItemKind.Class,
  metric: CompletionItemKind.Class,
  trainer: CompletionItemKind.Class,
  ml_model: CompletionItemKind.Class,
  ml_transform: CompletionItemKind.Class,
  ml_cluster: CompletionItemKind.Class,
  ml_split: CompletionItemKind.Class,
  grid_search: CompletionItemKind.Class,
  factory: CompletionItemKind.Function,
  data: CompletionItemKind.Function,
  function: CompletionItemKind.Function,
  global: CompletionItemKind.Function,
  step: CompletionItemKind.Method,
  linalg: CompletionItemKind.Function,
  ml_metric: CompletionItemKind.Function,
  ml_function: CompletionItemKind.Function,
  numeric_dist: CompletionItemKind.Function,
  numeric_func: CompletionItemKind.Function,
  numeric_transform: CompletionItemKind.Function,
  numeric_stats_test: CompletionItemKind.Function,
  numeric_timeseries: CompletionItemKind.Function,
  numeric_array_op: CompletionItemKind.Function,
  numeric_random: CompletionItemKind.Function,
  quant: CompletionItemKind.Function,
  device: CompletionItemKind.EnumMember,
  dtype: CompletionItemKind.EnumMember,
  constant: CompletionItemKind.Constant,
};

const EMPTY: CompletionList = { isIncomplete: false, items: [] };

export default defineProvider({
  id: "completion",
  register(connection, context) {
    connection.onCompletion((params: CompletionParams) => {
      try {
        const document = context.analyzer.get(params.textDocument.uri);
        return document ? collect(context, document, params.position) : EMPTY;
      } catch (error) {
        connection.console.error(`completion error: ${error instanceof Error ? error.stack : String(error)}`);
        return EMPTY;
      }
    });
  },
});

function collect(context: ProviderContext, document: AnalyzedDocument, position: Position): CompletionList {
  const receiver = readReceiver(document, position);
  if (receiver) {
    return { isIncomplete: false, items: memberItems(context, document, receiver, position) };
  }

  const items: CompletionItem[] = [
    ...namedArgumentItems(context, document, position),
    ...keywordItems(context),
    ...builtinItems(context),
    ...symbolItems(document, position),
  ];
  return { isIncomplete: false, items };
}

function namedArgumentItems(context: ProviderContext, document: AnalyzedDocument, position: Position): CompletionItem[] {
  const call = findEnclosingCall(document.lines, position);
  if (!call) return [];

  const builtin = context.types.builtin(call.callee);
  if (!builtin?.signature?.params.length) return [];

  const used = new Set(call.usedArgs);
  return builtin.signature.params
    .filter((param) => !used.has(param.name))
    .map((param) => ({
      label: `${param.name}=`,
      kind: CompletionItemKind.Field,
      detail: paramHint(param),
      insertText: `${param.name}=`,
      sortText: `0_${param.name}`,
      filterText: param.name,
    }));
}

function keywordItems(context: ProviderContext): CompletionItem[] {
  return context.languageData.keywords.map((keyword) => ({
    label: keyword,
    kind: CompletionItemKind.Keyword,
    sortText: `1_${keyword}`,
  }));
}

function builtinItems(context: ProviderContext): CompletionItem[] {
  return context.types.builtins.map((builtin) => {
    const item: CompletionItem = {
      label: builtin.name,
      kind: KIND_BY_BUILTIN[builtin.kind] ?? CompletionItemKind.Function,
      detail: builtin.signature?.display ?? builtin.kind,
      sortText: `2_${builtin.name}`,
    };
    if (builtin.description) item.documentation = { kind: "markdown", value: builtin.description };
    if (builtin.signature) {
      item.insertText = buildSnippet(builtin.name, builtin.signature.params);
      item.insertTextFormat = InsertTextFormat.Snippet;
    }
    return item;
  });
}

function symbolItems(document: AnalyzedDocument, position: Position): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const symbol of visibleSymbols(document.symbols.findScopeAt(position))) {
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    items.push({
      label: symbol.name,
      kind: KIND_BY_SYMBOL[symbol.kind] ?? CompletionItemKind.Variable,
      detail: symbol.typeName ? `${symbol.kind}: ${symbol.typeName}` : symbol.kind,
      sortText: `3_${symbol.name}`,
    });
  }
  return items;
}

function memberItems(
  context: ProviderContext,
  document: AnalyzedDocument,
  receiver: string,
  position: Position,
): CompletionItem[] {
  const typeName = document.symbols.resolve(receiver, position)?.typeName ?? receiver;
  const declaringScope = document.symbols.scopes.find(
    (scope) => scope.name === typeName && (scope.kind === "model" || scope.kind === "class"),
  );

  const methods = declaringScope
    ? context.types.pseudoType("Model") ?? []
    : context.types.methodsOf(typeName);

  const items = methods.map((method) => methodItem(method));

  if (declaringScope) {
    for (const field of declaringScope.symbols) {
      if (field.kind !== "variable" && field.kind !== "field") continue;
      items.push({
        label: field.name,
        kind: CompletionItemKind.Field,
        detail: field.typeName ? `${field.name}: ${field.typeName}` : "field",
        sortText: `0_${field.name}`,
      });
    }
  }
  return items;
}

function methodItem(method: Method): CompletionItem {
  const item: CompletionItem = {
    label: method.name,
    kind: method.isGetter ? CompletionItemKind.Property : CompletionItemKind.Method,
    detail: method.signature.display,
    sortText: `1_${method.name}`,
  };
  if (method.description) item.documentation = { kind: "markdown", value: method.description };
  if (method.isGetter) {
    item.insertText = method.name;
    return item;
  }
  item.insertText = buildSnippet(method.name, method.signature.params);
  item.insertTextFormat = InsertTextFormat.Snippet;
  return item;
}

function visibleSymbols(scope: Scope | null): TeraSymbol[] {
  const out: TeraSymbol[] = [];
  for (let cursor = scope; cursor; cursor = cursor.parent) out.push(...cursor.symbols);
  return out;
}

function readReceiver(document: AnalyzedDocument, position: Position): string | null {
  const line = document.lines[position.line] ?? "";
  const before = line.slice(0, position.character);
  return before.match(/([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z0-9_$]*$/)?.[1] ?? null;
}

function paramHint(param: Param): string {
  if (param.defaultValue) return `default ${param.defaultValue}`;
  if (param.rest) return "variadic";
  if (param.optional) return "optional";
  return "required";
}

function findEnclosingCall(lines: string[], position: Position): { callee: string; usedArgs: string[] } | null {
  const used: string[] = [];
  let depth = 0;
  let segment = "";
  let column = position.character - 1;

  for (let line = position.line; line >= 0; line--) {
    const text = lines[line] ?? "";
    if (line !== position.line) column = text.length - 1;

    while (column >= 0) {
      const char = text[column];
      if (char === ")" || char === "]") {
        depth++;
      } else if (char === "(" || char === "[") {
        if (depth === 0) {
          if (char !== "(") return null;
          collectNamedArg(segment, used);
          const callee = readIdentifierEndingAt(text, column - 1);
          return callee ? { callee, usedArgs: used.reverse() } : null;
        }
        depth--;
      } else if (char === "," && depth === 0) {
        collectNamedArg(segment, used);
        segment = "";
        column--;
        continue;
      } else if (char === '"' || char === "'") {
        column = skipStringBackward(text, column, char);
        continue;
      }
      segment = char + segment;
      column--;
    }
  }
  return null;
}

function collectNamedArg(segment: string, used: string[]): void {
  const match = segment.match(/^\s*([A-Za-z_$][\w$]*)\s*=/);
  if (match) used.push(match[1]);
}

function skipStringBackward(line: string, startColumn: number, quote: string): number {
  for (let i = startColumn - 1; i >= 0; i--) {
    if (line[i] === quote && line[i - 1] !== "\\") return i - 1;
  }
  return -1;
}

function readIdentifierEndingAt(line: string, endColumn: number): string | null {
  let i = endColumn;
  while (i >= 0 && /\s/.test(line[i])) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(line[i])) i--;
  const start = i + 1;
  return start === end ? null : line.slice(start, end);
}
