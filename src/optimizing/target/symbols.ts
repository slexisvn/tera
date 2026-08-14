export const C_KEYWORDS: readonly string[] = [
  "auto", "break", "case", "char", "const", "continue", "default", "do",
  "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline",
  "int", "long", "register", "restrict", "return", "short", "signed", "sizeof",
  "static", "struct", "switch", "typedef", "union", "unsigned", "void",
  "volatile", "while",
];

export const C_LIBRARY_NAMES: readonly string[] = [
  "main", "printf", "strlen", "trunc", "floor", "ceil", "fmod", "isfinite", "memcpy",
];

export const SYMBOL_PREFIX = "tera_";

export const MODULE_INIT_TABLE = "tera_module_inits";

export function moduleInitTable(symbols: readonly string[]): string {
  if (symbols.length === 0) return "";
  return [
    `typedef int32_t (*tera_module_init_fn)(void);`,
    `static tera_module_init_fn const ${MODULE_INIT_TABLE}[] = {`,
    ...symbols.map((symbol) => `  ${symbol},`),
    "  0,",
    "};",
  ].join("\n");
}

export function sanitizeSymbol(name: string, reserved: ReadonlySet<string>): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  const identifier = /^[A-Za-z_]/.test(sanitized) ? sanitized : `fn_${sanitized}`;
  return reserved.has(identifier) ? `${SYMBOL_PREFIX}${identifier}` : identifier;
}
