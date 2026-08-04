import terminalKit from "terminal-kit";
import { resolveMemberReceiverType, type SourceScope, type SourceSymbolTable, type SymbolPosition } from "../../frontend/index.js";
import { COMMAND_PREFIX, HELP_PREFIX, MAX_MENU_ITEMS } from "./config.js";
import { isMemberAccess, ownerExpression, splitTrailingWord } from "./text.js";
import type { Analyzer, CompletionContext, CompletionItem, CompletionProvider } from "./types.js";
import type { Language } from "./language.js";

type CompleteResult = string | string[];
const nativeAutoComplete = terminalKit.autoComplete;

const META_LINE = new RegExp(`^\\${COMMAND_PREFIX}[\\w-]*$`);
const HELP_LINE = new RegExp(`^\\${HELP_PREFIX}[\\w.$]*$`);

export type CompleterDeps = {
  language: Language;
  analyzer: Analyzer;
  sessionSource: () => string;
  engineGlobals: () => readonly string[];
  commandNames: () => readonly string[];
};

function scopeNames(symbols: SourceSymbolTable, position: SymbolPosition): string[] {
  const out = new Set<string>();
  let scope: SourceScope | null = symbols.findScopeAt(position);
  while (scope) {
    for (const symbol of scope.symbols) out.add(symbol.name);
    scope = scope.parent;
  }
  return [...out];
}

function memberCandidates(ctx: CompletionContext): CompletionItem[] {
  const { language, analysis } = ctx;
  if (ctx.ownerExpr === "chart") {
    return language.chartMethods.map((method) => ({ label: method.name, kind: "method", doc: method.description ?? undefined }));
  }
  const position = analysis.positionOf(ctx.line.length);
  const typeName = resolveMemberReceiverType(analysis.source, position, analysis.symbols, language.globalNamespaces);
  const members = typeName ? analysis.symbols.membersOf(typeName, position) : [];
  if (members.length) {
    return members.map((member) => ({ label: member.name, kind: member.kind, detail: member.typeName ?? undefined }));
  }
  return language.pseudoMethods.map((method) => ({ label: method.name, kind: method.isGetter ? "property" : "method", doc: method.description ?? undefined }));
}

function identifierCandidates(ctx: CompletionContext): CompletionItem[] {
  const { language, analysis, globals } = ctx;
  const items: CompletionItem[] = [];
  for (const builtin of language.data.builtins) items.push({ label: builtin.name, kind: builtin.kind || "function", doc: builtin.description ?? undefined });
  for (const keyword of language.data.keywords) items.push({ label: keyword, kind: "keyword" });
  for (const name of globals) items.push({ label: name, kind: "variable" });
  for (const name of scopeNames(analysis.symbols, analysis.positionOf(ctx.line.length))) items.push({ label: name, kind: "variable" });
  return items;
}

function buildProviders(deps: CompleterDeps): CompletionProvider[] {
  return [
    {
      match: (ctx) => META_LINE.test(ctx.line),
      complete: () => deps.commandNames().map((name) => ({ label: name, kind: "command" })),
    },
    {
      match: (ctx) => HELP_LINE.test(ctx.line),
      complete: (ctx) => [
        ...ctx.language.data.builtins.map((builtin) => ({ label: builtin.name, kind: "builtin" })),
        ...ctx.language.data.keywords.map((keyword) => ({ label: keyword, kind: "keyword" })),
      ],
    },
    { match: (ctx) => ctx.isMember, complete: memberCandidates },
    { match: () => true, complete: identifierCandidates },
  ];
}

function rank(items: CompletionItem[], word: string): string[] {
  const keepHidden = word.startsWith("_");
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const item of items) {
    const label = item.label;
    if (!label || label === "constructor" || seen.has(label)) continue;
    if (!label.startsWith(word)) continue;
    if (!keepHidden && label.startsWith("_")) continue;
    seen.add(label);
    labels.push(label);
  }
  labels.sort((a, b) => {
    if (a === word) return -1;
    if (b === word) return 1;
    return a.localeCompare(b);
  });
  return labels.length > MAX_MENU_ITEMS ? labels.slice(0, MAX_MENU_ITEMS) : labels;
}

export function createCompleter(deps: CompleterDeps): (input: string) => CompleteResult {
  const providers = buildProviders(deps);
  return (input) => {
    const { word, prefix } = splitTrailingWord(input);
    const analysis = deps.analyzer.analyze(deps.sessionSource(), input);
    const ctx: CompletionContext = {
      line: input,
      word,
      prefix,
      isMember: isMemberAccess(prefix),
      ownerExpr: ownerExpression(prefix),
      language: deps.language,
      analysis,
      globals: deps.engineGlobals(),
    };
    const provider = providers.find((candidate) => candidate.match(ctx));
    const labels = provider ? rank(provider.complete(ctx), word) : [];
    return nativeAutoComplete(labels, word, true, prefix);
  };
}
