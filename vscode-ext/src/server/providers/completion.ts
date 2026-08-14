import {
  CompletionItemKind, InsertTextFormat,
  type CompletionItem, type CompletionList, type CompletionParams,
} from "vscode-languageserver/node.js";
import { isStringLiteralTextPosition, type ModuleBindingKind } from "tera/frontend";
import type { Method, Param } from "@/shared/language-data";
import type { AnalyzedDocument, Position, Scope, TeraSymbol } from "../analyzer/index.ts";
import {
  importCompletionAt,
  importsIn,
  namespaceRequest,
  type ImportCompletion,
} from "../analyzer/import-syntax.ts";
import type { ModuleCandidate } from "../analyzer/modules.ts";
import { pathOfUri } from "../analyzer/paths.ts";
import { receiverNameAt } from "../analyzer/position.ts";
import { buildSnippet } from "@/shared/snippet";
import { isMemberAccess, resolveReceiverType } from "../language/members.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const KIND_BY_SYMBOL: Record<string, CompletionItemKind> = {
  model: CompletionItemKind.Class,
  module: CompletionItemKind.Class,
  function: CompletionItemKind.Function,
  parameter: CompletionItemKind.Variable,
  variable: CompletionItemKind.Variable,
  field: CompletionItemKind.Field,
  method: CompletionItemKind.Method,
  property: CompletionItemKind.Property,
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
        return document ? collectCompletions(context, params) : EMPTY;
      } catch (error) {
        connection.console.error(`completion error: ${error instanceof Error ? error.stack : String(error)}`);
        return EMPTY;
      }
    });
  },
});

export function collectCompletions(context: ProviderContext, params: CompletionParams): CompletionList {
  const document = context.analyzer.get(params.textDocument.uri);
  return document ? collect(context, params.textDocument.uri, document, params.position) : EMPTY;
}

function collect(context: ProviderContext, uri: string, document: AnalyzedDocument, position: Position): CompletionList {
  if (isStringLiteralTextPosition(document.text, position)) return EMPTY;

  const importing = importCompletionAt(document.lines, position);
  if (importing) return { isIncomplete: false, items: importItems(context, uri, importing) };

  if (isMemberAccess(document, position)) {
    const exports = namespaceExportItems(context, uri, document, position);
    if (exports) return { isIncomplete: false, items: exports };
    const typeName = resolveReceiverType(context, document, position);
    return { isIncomplete: false, items: typeName ? memberItems(context, document, typeName, position) : [] };
  }

  const items: CompletionItem[] = [
    ...namedArgumentItems(context, document, position),
    ...importedNameItems(context, uri, document),
    ...keywordItems(context),
    ...builtinItems(context),
    ...symbolItems(document, position),
  ];
  return { isIncomplete: false, items };
}

function importedNameItems(
  context: ProviderContext,
  uri: string,
  document: AnalyzedDocument,
): CompletionItem[] {
  const entryPath = pathOfUri(uri);
  if (entryPath === null) return [];
  return context.modules.importedNames(entryPath, document.lines).map((name) => ({
    label: name.local,
    kind: KIND_BY_BINDING[name.kind],
    detail: name.namespace ? `module ${name.label}` : `${name.kind} of ${name.label}`,
    sortText: `0_${name.local}`,
  }));
}

const KIND_BY_BINDING: Record<ModuleBindingKind, CompletionItemKind> = {
  function: CompletionItemKind.Function,
  class: CompletionItemKind.Class,
  model: CompletionItemKind.Class,
  interface: CompletionItemKind.Interface,
  type: CompletionItemKind.TypeParameter,
  value: CompletionItemKind.Variable,
  module: CompletionItemKind.Module,
};

const KIND_BY_MODULE: Record<ModuleCandidate["kind"], CompletionItemKind> = {
  file: CompletionItemKind.Module,
  package: CompletionItemKind.Folder,
  namespace: CompletionItemKind.Folder,
  native: CompletionItemKind.Module,
};

function importItems(context: ProviderContext, uri: string, request: ImportCompletion): CompletionItem[] {
  const entryPath = pathOfUri(uri);
  if (entryPath === null) return [];
  if (request.kind === "module") {
    return context.modules
      .listModules(entryPath, request.level, request.prefix)
      .map((candidate) => ({
        label: candidate.name,
        kind: KIND_BY_MODULE[candidate.kind],
        detail: candidate.kind === "native" ? "native module" : candidate.kind,
        sortText: `0_${candidate.name}`,
      }));
  }

  const level = request.syntax.level;
  const segments = request.syntax.path.map((token) => token.text);
  const taken = new Set(
    request.syntax.specifiers
      .map((specifier) => specifier.imported.text)
      .filter((name) => name !== request.typed),
  );
  return exportItems(context, entryPath, level, segments)
    .filter((item) => !taken.has(item.label));
}

function namespaceExportItems(
  context: ProviderContext,
  uri: string,
  document: AnalyzedDocument,
  position: Position,
): CompletionItem[] | null {
  const entryPath = pathOfUri(uri);
  const receiver = receiverNameAt(document.lines, position);
  if (entryPath === null || receiver === null) return null;
  const request = namespaceRequest(importsIn(document.lines), receiver);
  if (request === null) return null;
  return exportItems(context, entryPath, request.level, request.path);
}

function exportItems(
  context: ProviderContext,
  entryPath: string,
  level: number,
  segments: readonly string[],
): CompletionItem[] {
  const label = `${".".repeat(level)}${segments.join(".")}`;
  return context.modules.exportsOf(entryPath, level, segments).map((binding) => ({
    label: binding.name,
    kind: KIND_BY_BINDING[binding.kind],
    detail: `${binding.kind} of ${label}`,
    sortText: `0_${binding.name}`,
  }));
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
  typeName: string,
  position: Position,
): CompletionItem[] {
  const members = document.symbols.membersOf(typeName, position);
  if (members.length) {
    return members.map((member) => ({
      label: member.name,
      kind: member.kind === "method" ? CompletionItemKind.Method : member.kind === "property" ? CompletionItemKind.Property : CompletionItemKind.Field,
      detail: member.typeName ? `${member.name}: ${member.typeName}` : member.kind,
      sortText: `0_${member.name}`,
    }));
  }
  const element = typeName.endsWith("[]") ? "Array" : typeName;
  return context.types.methodsOf(element).map((method) => methodItem(method));
}

function methodItem(method: Method): CompletionItem {
  const item: CompletionItem = {
    label: method.name,
    kind: method.isGetter ? CompletionItemKind.Property : CompletionItemKind.Method,
    detail: method.isGetter && method.returns ? `${method.name}: ${method.returns}` : method.signature.display,
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
