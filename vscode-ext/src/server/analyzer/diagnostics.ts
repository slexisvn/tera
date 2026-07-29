import { diagnoseSource } from "../../../../src/frontend/index.ts";
import type { AnalyzedError } from "./types.ts";

export function analyzeDiagnostics(text: string): AnalyzedError[] {
  return diagnoseSource(text, "strict").map((diagnostic) => ({
    message: diagnostic.message,
    line: diagnostic.line,
    column: diagnostic.column,
    severity: diagnostic.severity,
    source: "checker",
  }));
}
