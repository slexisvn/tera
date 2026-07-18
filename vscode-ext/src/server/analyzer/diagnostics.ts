import { checkSource } from "@slexisvn/tera/frontend";
import type { AnalyzedError } from "./types.ts";

const LOCATION = / at (\d+):(\d+)/;

export function analyzeDiagnostics(text: string): AnalyzedError[] {
  try {
    return checkSource(text, "strict").map((diagnostic) => ({
      message: diagnostic.message,
      line: diagnostic.line,
      column: diagnostic.column,
      severity: diagnostic.severity,
      source: "checker",
    }));
  } catch (error) {
    const location = String(error instanceof Error ? error.message : error).match(LOCATION);
    return [{
      message: error instanceof Error ? error.message : String(error),
      line: location ? Number(location[1]) : 1,
      column: location ? Number(location[2]) : 1,
      severity: "error",
      source: "checker",
    }];
  }
}
