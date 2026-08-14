import { createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import { diagnoseSource } from "tera/frontend";
import type { AnalyzedError } from "./types.ts";

export function analyzeDiagnostics(text: string): AnalyzedError[] {
  return diagnoseSource(text, createReactiveCheckOptions()).map((diagnostic) => ({
    message: diagnostic.message,
    line: diagnostic.line,
    column: diagnostic.column,
    severity: diagnostic.severity,
    source: "checker",
  }));
}
