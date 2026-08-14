import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { isStringLiteralTextOffset, resolveMemberReceiverType } from "tera/frontend";
import { languageData, type Builtin, type Method } from "./language-data";
import type { NotebookSourceAnalysis } from "./source-analysis";

const memberItems = Object.values(languageData.pseudoTypes).flat();
const chartItems = languageData.builtins.find((item) => item.name === "chart")?.methods ?? [];

export function makeCompletionSource(completionNames: string[], analysis?: () => NotebookSourceAnalysis, cellId?: string) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = completionWord(context);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const prefix = word.text;
    const seen = new Set<string>();
    const options: Completion[] = [];
    const source = context.state.doc.toString();
    if (isStringLiteralTextOffset(source, word.from)) return null;
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
      const typeName = receiverType(context, word.from, analysis, cellId);
      const currentAnalysis = analysis?.();
      const members = typeName && currentAnalysis ? currentAnalysis.symbols.membersOf(typeName, currentAnalysis.positionFor(cellId!, source, word.from)) : [];
      if (members.length) {
        for (const item of members) add(item.name, item.kind === "method" ? "method" : item.kind === "property" ? "property" : "field", item.typeName ?? item.kind);
      } else {
        for (const item of memberItems) addMethod(item, item.isGetter ? "property" : "method");
      }
    } else {
      for (const item of languageData.builtins) addBuiltin(item);
      for (const name of completionNames) add(name, "variable");
      for (const name of languageData.keywords) add(name, "keyword");
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

function receiverType(context: CompletionContext, from: number, analysis: (() => NotebookSourceAnalysis) | undefined, cellId: string | undefined): string | null {
  if (!analysis || !cellId) return null;
  const source = context.state.doc.toString();
  const current = analysis();
  const position = current.positionFor(cellId, source, from);
  return resolveMemberReceiverType(current.source, position, current.symbols, languageData.globalNamespaces);
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
