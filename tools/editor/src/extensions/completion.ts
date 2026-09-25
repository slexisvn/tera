import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { isStringLiteralTextOffset, resolveMemberReceiverType, type SourceScope } from "tera/frontend";
import { languageData, parseParams, type Builtin, type Method, type Param } from "../language-data";
import type { AnalysisProvider } from "../types";

const memberItems = Object.values(languageData.pseudoTypes).flat();
const membersByType = new Map(Object.entries(languageData.pseudoTypes));
const chartItems = languageData.builtins.find((item) => item.name === "chart")?.methods ?? [];

export function makeCompletionSource(completionNames: readonly string[], analysis?: AnalysisProvider, documentId?: string) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = completionWord(context);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const prefix = word.text;
    const seen = new Set<string>();
    const options: Completion[] = [];
    const source = context.state.doc.toString();
    if (isStringLiteralTextOffset(source, word.from)) return null;
    if (isZeroArgCallPosition(context, word.from, analysis, documentId)) return null;
    const owner = ownerBeforeDot(context.state.doc.toString(), word.from);
    const memberAccess = nonSpaceBefore(source, word.from) === ".";
    const add = (label: string, type: string, detail?: string, info?: string) => {
      if (!label || seen.has(label) || label.startsWith("_") || !label.startsWith(prefix)) return;
      seen.add(label);
      options.push({ label, type, detail, info });
    };
    if (owner === "chart") {
      for (const item of chartItems) addMethod(item, "chart");
    } else if (memberAccess) {
      const typeName = receiverType(context, word.from, analysis, documentId);
      const currentAnalysis = analysis?.();
      const members = typeName && currentAnalysis ? currentAnalysis.symbols.membersOf(typeName, currentAnalysis.positionFor(documentId!, source, word.from)) : [];
      if (members.length) {
        for (const item of members) add(item.name, item.kind === "method" ? "method" : item.kind === "property" ? "property" : "field", item.typeName ?? item.kind);
      } else if (owner !== null && membersByType.has(owner)) {
        for (const item of membersByType.get(owner)!) addMethod(item, owner);
      } else {
        for (const item of memberItems) addMethod(item, item.isGetter ? "property" : "method");
      }
    } else {
      if (isTypeCompletionPosition(source, word.from)) {
        for (const name of typeCompletionNames(completionNames, analysis, documentId, source, word.from)) add(name, "type");
      } else {
        for (const item of languageData.builtins) addBuiltin(item);
        for (const name of completionNames) add(name, "variable");
        for (const name of languageData.keywords) add(name, "keyword");
      }
    }
    function addBuiltin(item: Builtin): void {
      add(item.name, item.kind || "function", item.kind, item.description ?? undefined);
    }

    function addMethod(item: Method, detail: string): void {
      add(item.name, item.isGetter ? "property" : "method", detail, item.description ?? undefined);
    }

    options.sort((a, b) => a.label.localeCompare(b.label));
    return options.length ? { from: word.from, options } : null;
  };
}

function completionWord(context: CompletionContext): { from: number; to: number; text: string } | null {
  const direct = context.matchBefore(/[A-Za-z_$][\w$]*/);
  if (direct) return direct;
  const before = context.state.sliceDoc(0, context.pos);
  if (/\.\s*$/.test(before)) return { from: context.pos, to: context.pos, text: "" };
  if (context.explicit) return { from: context.pos, to: context.pos, text: "" };
  return null;
}

function receiverType(context: CompletionContext, from: number, analysis: AnalysisProvider | undefined, documentId: string | undefined): string | null {
  if (!analysis || !documentId) return null;
  const source = context.state.doc.toString();
  const current = analysis();
  const position = current.positionFor(documentId, source, from);
  return resolveMemberReceiverType(current.source, position, current.symbols, languageData.globalNamespaces);
}

function typeCompletionNames(completionNames: readonly string[], analysis: AnalysisProvider | undefined, documentId: string | undefined, source: string, from: number): string[] {
  const names = new Set(languageData.types);
  for (const name of completionNames) names.add(name);
  if (analysis && documentId) {
    const current = analysis();
    const position = current.positionFor(documentId, source, from);
    for (const symbol of visibleSymbols(current.symbols.findScopeAt(position))) {
      if (symbol.kind === "model" || symbol.kind === "module" || symbol.kind === "type") names.add(symbol.name);
    }
  }
  return [...names];
}

function isZeroArgCallPosition(context: CompletionContext, from: number, analysis: AnalysisProvider | undefined, documentId: string | undefined): boolean {
  const source = context.state.doc.toString();
  const call = callBefore(source, from);
  if (!call) return false;
  if (call.receiver) {
    if (!analysis || !documentId) return false;
    const current = analysis();
    const position = current.positionFor(documentId, source, call.nameFrom);
    const typeName = resolveMemberReceiverType(current.source, position, current.symbols, languageData.globalNamespaces);
    const field = typeName ? current.symbols.resolveField(typeName, call.callee, position) : null;
    return isNoRequiredArgFunctionType(field?.typeName ?? null);
  }
  const builtin = languageData.builtins.find((item) => item.name === call.callee);
  return !!builtin?.signature && hasNoRequiredParams(builtin.signature.params);
}

function callBefore(source: string, from: number): { receiver?: string; callee: string; nameFrom: number } | null {
  let cursor = from - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  if (source[cursor] === ")") return null;
  const open = source.lastIndexOf("(", cursor);
  if (open < 0 || source.slice(open + 1, from).trim() !== "") return null;
  cursor = open - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  const end = cursor + 1;
  while (cursor >= 0 && /[\w$]/.test(source[cursor])) cursor--;
  const nameFrom = cursor + 1;
  const callee = source.slice(nameFrom, end);
  if (!callee) return null;
  cursor = nameFrom - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  if (source[cursor] !== ".") return { callee, nameFrom };
  cursor--;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  const receiverEnd = cursor + 1;
  while (cursor >= 0 && /[\w$]/.test(source[cursor])) cursor--;
  const receiver = source.slice(cursor + 1, receiverEnd);
  return receiver ? { receiver, callee, nameFrom } : { callee, nameFrom };
}

function isNoRequiredArgFunctionType(typeName: string | null): boolean {
  const params = paramsFromFunctionType(typeName);
  return params !== null && hasNoRequiredParams(params);
}

function paramsFromFunctionType(typeName: string | null): Param[] | null {
  if (typeName === null) return null;
  const arrow = typeName.lastIndexOf("->");
  if (arrow < 0) return null;
  const paramsText = typeName.slice(0, arrow).trim();
  if (!paramsText.startsWith("(") || !paramsText.endsWith(")")) return null;
  return parseParams(paramsText.slice(1, -1));
}

function hasNoRequiredParams(params: readonly Param[]): boolean {
  return params.every((param) => param.optional || param.rest || param.defaultValue !== undefined && param.defaultValue !== null);
}

function visibleSymbols(scope: SourceScope): Array<{ name: string; kind: string }> {
  const out: Array<{ name: string; kind: string }> = [];
  for (let cursor: typeof scope | null = scope; cursor; cursor = cursor.parent) out.push(...cursor.symbols);
  return out;
}

function isTypeCompletionPosition(source: string, from: number): boolean {
  const lineStart = source.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const before = source.slice(lineStart, from);
  return /(?::|->|\||&|<|,)\s*[A-Za-z_$][\w$]*$/.test(before)
    || /(?::|->|\||&|<|,)\s*$/.test(before);
}

function ownerBeforeDot(source: string, index: number): string | null {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  if (source[cursor] !== ".") return null;
  cursor--;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  let end = cursor + 1;
  while (cursor >= 0 && /[\w$]/.test(source[cursor])) cursor--;
  return source.slice(cursor + 1, end) || null;
}

function nonSpaceBefore(source: string, index: number): string {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  return cursor >= 0 ? source[cursor] : "";
}
