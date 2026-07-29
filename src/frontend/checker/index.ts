import { bindProgram } from "./binder.js";
import { parseSemanticProgram } from "./semantic-parser.js";
import { TypeChecker, type SymbolType } from "./type-checker.js";
export { TypecheckError } from "./diagnostics.js";
export { buildSourceSymbolTable } from "./symbols.js";
export type { Diagnostic, TypecheckMode } from "./diagnostics.js";
export type { ScopeKind, SourceScope, SourceSymbol, SourceSymbolTable, SymbolKind, SymbolPosition } from "./symbols.js";
export type { SymbolType } from "./type-checker.js";
import type { Diagnostic, TypecheckMode } from "./diagnostics.js";

const LOCATION = / at (\d+):(\d+)/;

export function checkSource(source: string, mode: TypecheckMode = "warn"): Diagnostic[] {
  if (mode === "off") return [];
  const program = parseSemanticProgram(source);
  const bound = bindProgram(program);
  return new TypeChecker(bound, mode === "strict").check();
}

export function inferSymbolTypes(source: string): SymbolType[] {
  const program = parseSemanticProgram(source);
  const bound = bindProgram(program);
  const symbols: SymbolType[] = [];
  new TypeChecker(bound, false, (symbol) => symbols.push(symbol)).check();
  return symbols;
}

export function diagnoseSource(source: string, mode: TypecheckMode = "warn"): Diagnostic[] {
  if (mode === "off") return [];
  try {
    return checkSource(source, mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const location = message.match(LOCATION);
    return [{
      message,
      line: location ? Number(location[1]) : 1,
      column: location ? Number(location[2]) : 1,
      severity: "error",
    }];
  }
}
