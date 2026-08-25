import type { SourceSymbolTable, SymbolPosition } from "tera/frontend";

export type TeraDocument = {
  readonly id: string;
  readonly source: string;
};

export type TeraDiagnostic = {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning";
  readonly message: string;
};

export type TeraSourceAnalysis = {
  readonly source: string;
  readonly symbols: SourceSymbolTable;
  positionFor(documentId: string, source: string, offset: number): SymbolPosition;
};

export type AnalysisProvider = () => TeraSourceAnalysis;

export type DocumentContext = {
  readonly analysis?: AnalysisProvider;
  readonly documentId?: string;
  readonly diagnostics?: readonly TeraDiagnostic[];
};
