import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, ViewPlugin, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { isStringLiteralTextOffset, resolveMemberReceiverType, stringLiteralTextPredicate } from "../../../src/frontend";
import type { NotebookDiagnostic } from "../services/diagnostics";
import { BUILTIN_SET, KEYWORD_SET, tokenClass, TOKEN_RE } from "./highlight";
import { languageData } from "./language-data";
import type { NotebookSourceAnalysis } from "./source-analysis";

type HoverDoc = {
  title: string;
  kind: string;
  description: string;
  signature?: string;
  diagnostics?: HoverDiagnostic[];
};

type HoverDiagnostic = {
  message: string;
  severity: "error" | "warning";
};

const builtinDocs = new Map<string, HoverDoc>();
const memberDocs = new Map<string, HoverDoc>();
const memberDocsByOwner = new Map<string, HoverDoc>();
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
    const doc = {
      title: `${typeName}.${method.name}`,
      kind: method.isGetter ? "property" : "method",
      description: method.description || "",
      signature: method.signature?.display,
    };
    memberDocs.set(method.name, doc);
    memberDocsByOwner.set(`${typeName}.${method.name}`, doc);
  }
}

for (const method of languageData.builtins.find((item) => item.name === "chart")?.methods || []) {
  chartDocs.set(method.name, {
    title: `chart.${method.name}`,
    kind: "chart",
    description: method.description || "",
    signature: method.signature?.display,
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

export function teraCodeMirrorExtensions(options: { analysis?: () => NotebookSourceAnalysis; cellId?: string; diagnostics?: readonly NotebookDiagnostic[] } = {}): Extension[] {
  return [
    teraHighlightPlugin,
    hoverTooltip((view, pos) => teraHover(view, pos, options)),
  ];
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const source = view.state.doc.toString();
  const isStringText = stringLiteralTextPredicate(source);
  for (const range of view.visibleRanges) {
    const text = view.state.doc.sliceString(range.from, range.to);
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(text))) {
      const token = match[0];
      const from = range.from + match.index;
      const cls = tokenClass(token, source, from, isStringText);
      if (cls) builder.add(from, from + token.length, Decoration.mark({ class: cls }));
    }
  }
  return builder.finish();
}

function teraHover(view: EditorView, pos: number, options: { analysis?: () => NotebookSourceAnalysis; cellId?: string; diagnostics?: readonly NotebookDiagnostic[] }): Tooltip | null {
  const source = view.state.doc.toString();
  const word = wordAt(view, pos);
  const diagnostics = diagnosticsFor(options.diagnostics, word?.from ?? pos, word?.to ?? pos);
  const baseDoc = word
    ? memberHoverFor(source, word.text, word.from, options) ?? typeHoverFor(view, word.text, word.from, options) ?? hoverDocFor(source, word.text, word.from)
    : null;
  const doc = mergeHover(baseDoc, diagnostics);
  if (!doc) return null;
  const from = word?.from ?? options.diagnostics?.find((item) => diagnostics.some((diagnostic) => diagnostic.message === item.message))?.from ?? pos;
  const to = word?.to ?? options.diagnostics?.find((item) => diagnostics.some((diagnostic) => diagnostic.message === item.message))?.to ?? pos + 1;
  return {
    pos: from,
    end: to,
    above: true,
    create() {
      return { dom: renderHover(doc) };
    },
  };
}

export function notebookHoverDocFor(
  source: string,
  token: string,
  from: number,
  options: { analysis?: () => NotebookSourceAnalysis; cellId?: string; diagnostics?: readonly NotebookDiagnostic[] } = {},
): HoverDoc | null {
  if (isStringLiteralTextOffset(source, from)) return null;
  return mergeHover(
    memberHoverFor(source, token, from, options) ?? symbolHoverFor(source, token, from, options) ?? hoverDocFor(source, token, from),
    diagnosticsFor(options.diagnostics, from, from + token.length),
  );
}

function memberHoverFor(source: string, token: string, from: number, options: { analysis?: () => NotebookSourceAnalysis; cellId?: string }): HoverDoc | null {
  if (nonSpaceBefore(source, from) !== ".") return null;
  const owner = ownerBeforeDot(source, from);
  if (owner === "chart") return chartDocs.get(token) ?? null;

  const typeName = receiverType(source, from, options);
  if (typeName) {
    const method = methodDoc(typeName, token);
    if (method) return method;
    const analysis = options.analysis?.();
    const position = options.cellId && analysis ? analysis.positionFor(options.cellId, source, from) : undefined;
    const field = analysis?.symbols.resolveField(typeName, token, position);
    if (field) {
      const description = field.typeName ? `type: ${field.typeName}` : "";
      const builtin = field.typeName ? builtinDocs.get(field.typeName) : null;
      return {
        title: `${typeName}.${field.name}`,
        kind: field.kind === "method" ? "method" : field.kind === "property" ? "property" : "field",
        description: builtin?.description ? `${description}\n\n${builtin.description}` : description,
        signature: builtin?.signature,
      };
    }
  }

  return memberDocs.get(token) ?? null;
}

function typeHoverFor(view: EditorView, token: string, from: number, options: { analysis?: () => NotebookSourceAnalysis; cellId?: string }): HoverDoc | null {
  return symbolHoverFor(view.state.doc.toString(), token, from, options);
}

function symbolHoverFor(source: string, token: string, from: number, options: { analysis?: () => NotebookSourceAnalysis; cellId?: string }): HoverDoc | null {
  if (!options.analysis || !options.cellId) return null;
  if (nonSpaceBefore(source, from) === ".") return null;
  const analysis = options.analysis();
  const position = analysis.positionFor(options.cellId, source, from);
  const symbol = analysis.symbols.resolve(token, position);
  if (!symbol) return null;
  return {
    title: symbol.name,
    kind: symbol.kind,
    description: symbol.typeName ? `type: ${symbol.typeName}` : "",
  };
}

function receiverType(source: string, from: number, options: { analysis?: () => NotebookSourceAnalysis; cellId?: string }): string | null {
  if (!options.analysis || !options.cellId) return null;
  const analysis = options.analysis();
  const position = analysis.positionFor(options.cellId, source, from);
  return resolveMemberReceiverType(analysis.source, position, analysis.symbols, languageData.globalNamespaces);
}

function methodDoc(typeName: string, token: string): HoverDoc | null {
  const element = typeName.endsWith("[]") ? "Array" : typeName;
  return memberDocsByOwner.get(`${element}.${token}`) ?? memberDocsByOwner.get(`${typeName}.${token}`) ?? null;
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

function diagnosticsFor(diagnostics: readonly NotebookDiagnostic[] | undefined, from: number, to: number): HoverDiagnostic[] {
  if (!diagnostics?.length) return [];
  return diagnostics
    .filter((diagnostic) => overlaps(diagnostic.from, diagnostic.to, from, to))
    .map((diagnostic) => ({ message: diagnostic.message, severity: diagnostic.severity }));
}

function overlaps(leftFrom: number, leftTo: number, rightFrom: number, rightTo: number): boolean {
  if (rightFrom === rightTo) return leftFrom <= rightFrom && rightFrom <= leftTo;
  return leftFrom < rightTo && rightFrom < leftTo;
}

function mergeHover(doc: HoverDoc | null, diagnostics: HoverDiagnostic[]): HoverDoc | null {
  if (!diagnostics.length) return doc;
  if (!doc) return {
    title: diagnostics.length === 1 ? "Diagnostic" : "Diagnostics",
    kind: diagnostics.some((item) => item.severity === "error") ? "error" : "warning",
    description: "",
    diagnostics,
  };
  return { ...doc, diagnostics };
}

function renderHover(doc: HoverDoc): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-tera-hover";

  if (doc.title) {
    const title = document.createElement("div");
    title.className = "cm-tera-hover-title";
    title.textContent = doc.title;
    dom.append(title);
  }

  if (doc.kind) {
    const kind = document.createElement("div");
    kind.className = "cm-tera-hover-kind";
    kind.textContent = doc.kind;
    dom.append(kind);
  }

  if (doc.description) {
    const desc = document.createElement("div");
    desc.className = "cm-tera-hover-desc";
    desc.textContent = doc.description;
    dom.append(desc);
  }

  if (doc.signature) {
    const signature = document.createElement("code");
    signature.className = "cm-tera-hover-signature";
    signature.textContent = doc.signature;
    dom.append(signature);
  }

  if (doc.diagnostics?.length) {
    const list = document.createElement("div");
    list.className = "cm-tera-hover-diagnostics";
    for (const diagnostic of doc.diagnostics) {
      const item = document.createElement("div");
      item.className = `cm-tera-hover-diagnostic ${diagnostic.severity}`;
      item.textContent = diagnostic.message;
      list.append(item);
    }
    dom.append(list);
  }

  return dom;
}

function wordAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  const left = line.text.slice(0, offset).match(/[A-Za-z_$][\w$]*$/)?.[0] ?? "";
  const right = line.text.slice(offset).match(/^[\w$]*/)?.[0] ?? "";
  const text = left + right;
  if (!text) return null;
  const from = pos - left.length;
  if (isStringLiteralTextOffset(view.state.doc.toString(), from)) return null;
  return { from, to: pos + right.length, text };
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
