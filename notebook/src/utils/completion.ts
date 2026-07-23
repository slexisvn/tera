import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import languageData from "../../../vscode-ext/language-data.json";
import { KEYWORDS } from "../config/constants";

type BuiltinItem = {
  name: string;
  kind?: string;
  description?: string;
  methods?: PseudoMethodItem[];
};

type PseudoMethodItem = {
  name: string;
  isGetter?: boolean;
  description?: string;
};

const memberItems: PseudoMethodItem[] = Object.values(languageData.pseudoTypes || {}).flat() as PseudoMethodItem[];
const chartItems = ((languageData.builtins as BuiltinItem[]).find((item) => item.name === "chart")?.methods || []) as PseudoMethodItem[];

export function makeCompletionSource(completionNames: string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[A-Za-z_]\w*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const prefix = word.text;
    const seen = new Set<string>();
    const options: Completion[] = [];
    const owner = ownerBeforeDot(context.state.doc.toString(), word.from);
    const add = (label: string, type: string, detail?: string, info?: string) => {
      if (!label || seen.has(label) || label.startsWith("_") || !label.startsWith(prefix)) return;
      seen.add(label);
      options.push({ label, type, detail, info });
    };
    if (owner === "chart") {
      for (const item of chartItems) add(item.name, "function", "chart", item.description);
    } else if (owner) {
      for (const item of memberItems) add(item.name, item.isGetter ? "property" : "method", item.isGetter ? "property" : "method", item.description);
    } else {
      for (const item of languageData.builtins as BuiltinItem[]) add(item.name, item.kind || "function", item.kind, item.description);
      for (const name of completionNames) add(name, "variable");
      for (const name of KEYWORDS) add(name, "keyword");
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options.length ? { from: word.from, options } : null;
  };
}

function ownerBeforeDot(source: string, index: number): string | null {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  if (source[cursor] !== ".") return null;
  cursor--;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  let end = cursor + 1;
  while (cursor >= 0 && /\w/.test(source[cursor])) cursor--;
  return source.slice(cursor + 1, end) || null;
}
