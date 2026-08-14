import { KEYWORD_GROUP_ROLE, resolveStyle, type Theme, type TokenRole } from "./theme.js";
import type { Language } from "./language.js";
import type { Terminal, TokenHook, TermStyle } from "./types.js";

const TOKEN_PATTERNS = [
  "#[^\\n]*",
  "//[^\\n]*",
  "/\\*[\\s\\S]*?\\*/",
  "`(?:\\\\.|[^`\\\\])*`",
  '"(?:\\\\.|[^"\\\\])*"',
  "'(?:\\\\.|[^'\\\\])*'",
  "0[xXbBoO][0-9a-fA-F_]+",
  "\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?",
  "[A-Za-z_$][\\w$]*",
  "[+\\-*/%=<>!&|^~?]+",
  "[{}()\\[\\].,;:]",
  "\\s+",
];

export const TERA_TOKEN_REGEXP = new RegExp(TOKEN_PATTERNS.join("|"), "g");

function classify(token: string, language: Language): TokenRole | null {
  const head = token[0];
  if (head === "#" || token.startsWith("//") || token.startsWith("/*")) return "comment";
  if (head === "`" || head === '"' || head === "'") return "string";
  if (head >= "0" && head <= "9") return "number";
  if (/[A-Za-z_$]/.test(head)) {
    const group = language.keywordGroup.get(token);
    if (group) return KEYWORD_GROUP_ROLE[group];
    if (language.types.has(token)) return "type";
    if (language.builtins.has(token)) return "builtin";
    return null;
  }
  if (/[+\-*/%=<>!&|^~?]/.test(head)) return "operator";
  return null;
}

export function createTokenHook(language: Language, theme: Theme): TokenHook {
  return (token, _isEndOfInput, _previousTokens, term) => {
    const role = classify(token, language);
    if (!role) return undefined;
    return resolveStyle(term as Terminal, theme.tokens[role]) as TermStyle | undefined;
  };
}
