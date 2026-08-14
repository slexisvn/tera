import {
  extractReceiverExpression,
  isStringLiteralTextOffset,
  resolveMemberReceiverType,
} from "../../frontend/index.js";
import { paint, type Theme } from "./theme.js";
import type { Analyzer, InputController, KeyData, KeyHandler, Terminal } from "./types.js";
import type { Language } from "./language.js";

export type SignatureDeps = {
  term: Terminal;
  language: Language;
  analyzer: Analyzer;
  theme: Theme;
  sessionSource: () => string;
};

function openCallParen(text: string, cursor: number): number {
  let depth = 0;
  for (let i = cursor - 1; i >= 0; i--) {
    if (isStringLiteralTextOffset(text, i)) continue;
    const ch = text[i];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "[" || ch === "{") {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === "(") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function calleeAt(text: string, parenIndex: number): string {
  return extractReceiverExpression(text.slice(0, parenIndex));
}

function formatMemberSignature(name: string, typeName: string): string {
  if (typeName.includes("->")) return `${name}${typeName}`;
  return `${name}: ${typeName}`;
}

function resolveSignature(callee: string, deps: SignatureDeps): string | null {
  const dot = callee.lastIndexOf(".");
  const simple = dot < 0 ? callee : callee.slice(dot + 1);
  if (dot < 0) {
    return deps.language.signatureOf(simple);
  }
  const owner = callee.slice(0, dot);
  const probe = `${owner}.`;
  const analysis = deps.analyzer.analyze(deps.sessionSource(), probe);
  const position = analysis.positionOf(probe.length);
  const typeName = resolveMemberReceiverType(analysis.source, position, analysis.symbols, deps.language.globalNamespaces);
  const field = typeName ? analysis.symbols.resolveField(typeName, simple, position) : null;
  if (field?.typeName) return formatMemberSignature(simple, field.typeName);
  return deps.language.signatureOf(simple);
}

function computeSignature(deps: SignatureDeps, controller: InputController): string | null {
  const text = controller.getInput();
  if (text.includes("\n")) return null;
  const cursor = controller.getCursorPosition();
  const parenIndex = openCallParen(text, cursor);
  if (parenIndex < 0) return null;
  const callee = calleeAt(text, parenIndex);
  if (!callee) return null;
  return resolveSignature(callee, deps);
}

export function attachSignatureHint(deps: SignatureDeps, controller: InputController): () => void {
  const { term, theme } = deps;
  let shown = false;

  const clear = (): void => {
    if (!shown) return;
    try {
      term.saveCursor();
      term.down(1);
      term.column(1);
      term.eraseLineAfter();
      term.restoreCursor();
    } catch {}
    shown = false;
  };

  const draw = (signature: string): void => {
    try {
      term.saveCursor();
      term.down(1);
      term.column(1);
      term.eraseLineAfter();
      term(paint(term, theme.ui.signature, signature));
      term.restoreCursor();
      shown = true;
    } catch {}
  };

  let last: string | null = null;
  const onKey: KeyHandler = (key: string, _matches?: unknown, data?: KeyData) => {
    if (key === "TAB") {
      clear();
      last = null;
      return;
    }
    if (!data?.isCharacter && key !== "BACKSPACE" && key !== "DELETE" && key !== "LEFT" && key !== "RIGHT") return;
    let signature: string | null = null;
    try {
      signature = computeSignature(deps, controller);
    } catch {
      signature = null;
    }
    if (signature === last) return;
    last = signature;
    clear();
    if (signature) draw(signature);
  };

  term.on("key", onKey);
  const cleanup = (): void => {
    clear();
    term.removeListener("key", onKey);
  };
  controller.promise.then(cleanup, cleanup);
  return cleanup;
}
