import { bindProgram } from "./binder.js";
import { parseSemanticProgram } from "./semantic-parser.js";
import { TypeChecker } from "./type-checker.js";
export { TypecheckError } from "./diagnostics.js";
export type { Diagnostic, TypecheckMode } from "./diagnostics.js";
import type { Diagnostic, TypecheckMode } from "./diagnostics.js";

export function checkSource(source: string, mode: TypecheckMode = "warn"): Diagnostic[] {
  if (mode === "off") return [];
  const program = parseSemanticProgram(source);
  const bound = bindProgram(program);
  return new TypeChecker(bound, mode === "strict").check();
}
