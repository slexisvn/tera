export type TypecheckMode = "off" | "warn" | "strict";

export type Diagnostic = {
  line: number;
  column: number;
  message: string;
  severity: "warning" | "error";
};

export class TypecheckError extends Error {
  diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("\n"));
    this.name = "TypecheckError";
    this.diagnostics = diagnostics;
  }
}

export function diagnostic(
  line: number,
  column: number,
  message: string,
  strict: boolean,
): Diagnostic {
  return { line, column, message, severity: strict ? "error" : "warning" };
}
