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

export type SymbolKind = "function" | "model" | "module" | "variable" | "parameter" | "field" | "method" | "property";

export type ScopeKind = "scope" | "function" | "class" | "model" | "interface";

export type TeraSymbol = {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  typeName: string | null;
  scope?: Scope;
};

export type Scope = {
  name: string;
  kind: ScopeKind;
  parent: Scope | null;
  children: Scope[];
  symbols: TeraSymbol[];
  startLine: number;
  endLine: number;
  indent: number;
};

export type SymbolTable = {
  root: Scope;
  scopes: Scope[];
  flat: TeraSymbol[];
  findScopeAt(position: Position): Scope;
  resolve(name: string, position: Position): TeraSymbol | null;
  resolveField(typeName: string | null, fieldName: string): TeraSymbol | null;
  membersOf(typeName: string | null): TeraSymbol[];
};

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
