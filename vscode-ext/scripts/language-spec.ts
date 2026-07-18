import type { KeywordGroup, Operators } from "../src/shared/language-data.ts";

export const KEYWORD_GROUPS: Record<KeywordGroup, string[]> = {
  declaration: ["fn", "model", "class", "function", "let", "const", "var", "extends"],
  control: [
    "if", "else", "for", "while", "do", "return", "switch", "case", "default",
    "break", "continue", "try", "catch", "finally", "throw", "async", "await", "yield",
  ],
  operator: ["and", "or", "not", "in", "of", "instanceof", "typeof", "delete", "void", "new"],
  constant: ["true", "false", "null", "undefined"],
  variable: ["this", "super"],
};

export const PRIMITIVE_TYPES = [
  "any", "unknown", "number", "int", "float", "string", "bool", "boolean",
  "Map", "Set", "Array", "Object",
];

export const OPERATORS: Operators = {
  threeChar: [">>>=", "===", "!==", ">>>", "**=", "<<=", ">>=", "..."],
  twoChar: [
    "=>", "->", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--",
    "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
  ],
  oneChar: ["+", "-", "*", "/", "%", "@", "<", ">", "=", "!", "&", "|", "^", "~", "?", ":", ".", ",", "(", ")", "[", "]", "{", "}", ";"],
};

export function assertKeywordsInSync(lexerKeywords: Iterable<string>): string[] {
  const actual = new Set(lexerKeywords);
  const grouped = new Set(Object.values(KEYWORD_GROUPS).flat());

  const missing = [...actual].filter((k) => !grouped.has(k)).sort();
  const stale = [...grouped].filter((k) => !actual.has(k)).sort();

  if (missing.length || stale.length) {
    const details = [
      missing.length ? `not grouped (add to KEYWORD_GROUPS): ${missing.join(", ")}` : "",
      stale.length ? `no longer in the lexer (remove): ${stale.join(", ")}` : "",
    ].filter(Boolean).join("\n  ");
    throw new Error(`language-spec.ts is out of sync with the Tera lexer:\n  ${details}`);
  }

  return [...grouped].sort();
}
