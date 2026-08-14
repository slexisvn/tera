import type {
  ScopeKind,
  SourceScope,
  SourceSymbol,
  SourceSymbolTable,
  SymbolKind,
} from "tera/frontend";

export type Position = { line: number; character: number };

export type Range = { start: Position; end: Position };

export type TokenKind = "keyword" | "identifier" | "number" | "string" | "operator";

export type AnalyzedToken = {
  type: TokenKind;
  value: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

export type { ScopeKind, SymbolKind };
export type Scope = SourceScope;
export type TeraSymbol = SourceSymbol;
export type SymbolTable = SourceSymbolTable;

export type AnalyzedError = {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  source: string;
};

export type AnalyzedDocument = {
  text: string;
  lines: string[];
  tokens: AnalyzedToken[];
  ast: unknown;
  symbols: SymbolTable;
  errors: AnalyzedError[];
};
