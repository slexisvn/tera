import type { KeywordGroup } from "../../frontend/index.js";
import type { Terminal, TermStyle } from "./types.js";

export type TokenRole =
  | "declaration"
  | "control"
  | "operatorKeyword"
  | "constant"
  | "variableKeyword"
  | "builtin"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "operator";

export type UiRole =
  | "hint"
  | "signature"
  | "result"
  | "error"
  | "warning"
  | "meta"
  | "banner"
  | "prompt"
  | "muted";

export type StyleChain = readonly string[];

export type Theme = {
  tokens: Partial<Record<TokenRole, StyleChain>>;
  ui: Record<UiRole, StyleChain>;
};

export const KEYWORD_GROUP_ROLE: Record<KeywordGroup, TokenRole> = {
  declaration: "declaration",
  control: "control",
  operator: "operatorKeyword",
  constant: "constant",
  variable: "variableKeyword",
};

export const defaultTheme: Theme = {
  tokens: {
    declaration: ["brightMagenta"],
    control: ["magenta"],
    operatorKeyword: ["brightMagenta"],
    constant: ["yellow"],
    variableKeyword: ["red"],
    builtin: ["brightCyan"],
    type: ["cyan"],
    string: ["green"],
    number: ["yellow"],
    comment: ["brightBlack"],
    operator: ["white"],
  },
  ui: {
    hint: ["brightBlack"],
    signature: ["brightBlack"],
    result: ["brightWhite"],
    error: ["brightRed"],
    warning: ["yellow"],
    meta: ["cyan"],
    banner: ["brightCyan"],
    prompt: ["brightGreen", "bold"],
    muted: ["brightBlack"],
  },
};

function descend(base: unknown, name: string): unknown {
  if (!base) return undefined;
  const type = typeof base;
  if (type !== "object" && type !== "function") return undefined;
  return (base as Record<string, unknown>)[name];
}

export function resolveStyle(term: Terminal, chain: StyleChain | undefined): TermStyle | undefined {
  if (!chain || chain.length === 0) return undefined;
  let acc: unknown = term;
  for (const name of chain) {
    acc = descend(acc, name);
    if (!acc) return undefined;
  }
  return acc as TermStyle;
}

export function paint(term: Terminal, chain: StyleChain | undefined, text: string): string {
  const style = resolveStyle(term, chain);
  if (!style || typeof (style as { str?: unknown }).str !== "function") return text;
  return (style as unknown as { str(text: string): string }).str(text);
}
