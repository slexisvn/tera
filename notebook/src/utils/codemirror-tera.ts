import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, ViewPlugin, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import type { LanguageData } from "../../../vscode-ext/src/shared/language-data";
import rawLanguageData from "../../../vscode-ext/language-data.json";
import { CHART_METHOD_DOCS } from "../chart/docs";
import { BUILTIN_SET, KEYWORD_SET, tokenClass, TOKEN_RE } from "./highlight";

const languageData = rawLanguageData as unknown as LanguageData;

type HoverDoc = {
  title: string;
  kind: string;
  description: string;
  signature?: string;
};

const builtinDocs = new Map<string, HoverDoc>();
const memberDocs = new Map<string, HoverDoc>();
const chartDocs = new Map<string, HoverDoc>();

for (const item of languageData.builtins) {
  builtinDocs.set(item.name, {
    title: item.name,
    kind: item.kind || "builtin",
    description: item.description || "",
    signature: item.signature?.display,
  });
}

for (const [typeName, methods] of Object.entries(languageData.pseudoTypes)) {
  for (const method of methods) {
    memberDocs.set(method.name, {
      title: `${typeName}.${method.name}`,
      kind: method.isGetter ? "property" : "method",
      description: method.description || "",
      signature: method.signature?.display,
    });
  }
}

for (const [name, info] of CHART_METHOD_DOCS.entries()) {
  chartDocs.set(name, {
    title: `chart.${name}`,
    kind: "chart",
    description: info.description,
    signature: info.display,
  });
}

const teraHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = buildDecorations(update.view);
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

export function teraCodeMirrorExtensions(): Extension[] {
  return [
    teraHighlightPlugin,
    hoverTooltip((view, pos) => teraHover(view, pos)),
  ];
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    const text = view.state.doc.sliceString(range.from, range.to);
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(text))) {
      const token = match[0];
      const from = range.from + match.index;
      const cls = tokenClass(token, view.state.doc.toString(), from);
      if (cls) builder.add(from, from + token.length, Decoration.mark({ class: cls }));
    }
  }
  return builder.finish();
}

function teraHover(view: EditorView, pos: number): Tooltip | null {
  const word = wordAt(view, pos);
  if (!word) return null;
  const doc = hoverDocFor(view.state.doc.toString(), word.text, word.from);
  if (!doc) return null;
  return {
    pos: word.from,
    end: word.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-tera-hover";
      const title = document.createElement("div");
      title.className = "cm-tera-hover-title";
      title.textContent = doc.title;
      const kind = document.createElement("div");
      kind.className = "cm-tera-hover-kind";
      kind.textContent = doc.kind;
      const desc = document.createElement("div");
      desc.className = "cm-tera-hover-desc";
      desc.textContent = doc.description || "No description available.";
      dom.append(title, kind, desc);
      if (doc.signature) {
        const signature = document.createElement("code");
        signature.className = "cm-tera-hover-signature";
        signature.textContent = doc.signature;
        dom.append(signature);
      }
      return { dom };
    },
  };
}

function hoverDocFor(source: string, token: string, from: number): HoverDoc | null {
  if (nonSpaceBefore(source, from) === ".") {
    const owner = ownerBeforeDot(source, from);
    if (owner === "chart") return chartDocs.get(token) ?? null;
    return memberDocs.get(token) ?? null;
  }
  if (KEYWORD_SET.has(token)) return { title: token, kind: "keyword", description: "Tera language keyword." };
  if (BUILTIN_SET.has(token)) return builtinDocs.get(token) ?? { title: token, kind: "builtin", description: "Tera builtin." };
  return builtinDocs.get(token) ?? null;
}

function wordAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  const left = line.text.slice(0, offset).match(/[A-Za-z_]\w*$/)?.[0] ?? "";
  const right = line.text.slice(offset).match(/^\w*/)?.[0] ?? "";
  const text = left + right;
  if (!text) return null;
  return { from: pos - left.length, to: pos + right.length, text };
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

function nonSpaceBefore(source: string, index: number): string {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  return cursor >= 0 ? source[cursor] : "";
}
