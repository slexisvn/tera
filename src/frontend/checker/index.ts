import { bindProgram, type BindOptions, type ExternalBuiltinSignature } from "./binder.js";
import { parseSemanticProgram } from "./semantic-parser.js";
import { TypeChecker, type SymbolType } from "./type-checker.js";
export { TypecheckError } from "./diagnostics.js";
export { buildSourceSymbolTable } from "./symbols.js";
export type { Diagnostic, TypecheckMode } from "./diagnostics.js";
export type { BindOptions, ExternalBuiltinParam, ExternalBuiltinSignature, ExternalInterface, ExternalInterfaceField, ExternalTypeAlias } from "./binder.js";
export type { ScopeKind, SourceScope, SourceSymbol, SourceSymbolTable, SymbolKind, SymbolPosition } from "./symbols.js";
export type { SymbolType } from "./type-checker.js";
import type { Diagnostic, TypecheckMode } from "./diagnostics.js";
import type { SyntaxPlugin } from "../parser/extensions.js";

const LOCATION = / at (\d+):(\d+)/;

export type CheckSourceOptions = {
  mode?: TypecheckMode;
  syntaxPlugins?: readonly SyntaxPlugin[];
  builtins?: readonly ExternalBuiltinSignature[];
  aliases?: BindOptions["aliases"];
  interfaces?: BindOptions["interfaces"];
};

function checkOptions(modeOrOptions: TypecheckMode | CheckSourceOptions): Required<Pick<CheckSourceOptions, "mode">> & Omit<CheckSourceOptions, "mode"> {
  return typeof modeOrOptions === "string"
    ? { mode: modeOrOptions }
    : {
      mode: modeOrOptions.mode ?? "warn",
      syntaxPlugins: modeOrOptions.syntaxPlugins,
      builtins: modeOrOptions.builtins,
      aliases: modeOrOptions.aliases,
      interfaces: modeOrOptions.interfaces,
    };
}

export function checkSource(source: string, modeOrOptions: TypecheckMode | CheckSourceOptions = "warn"): Diagnostic[] {
  const options = checkOptions(modeOrOptions);
  const mode = options.mode;
  if (mode === "off") return [];
  const program = parseSemanticProgram(source, { syntaxPlugins: options.syntaxPlugins });
  const bound = bindProgram(program, { builtins: options.builtins, aliases: options.aliases, interfaces: options.interfaces });
  return new TypeChecker(bound, mode === "strict").check();
}

export function inferSymbolTypes(source: string, options: Omit<CheckSourceOptions, "mode"> = {}): SymbolType[] {
  const program = parseSemanticProgram(source, { syntaxPlugins: options.syntaxPlugins });
  const bound = bindProgram(program, { builtins: options.builtins, aliases: options.aliases, interfaces: options.interfaces });
  const symbols: SymbolType[] = [];
  new TypeChecker(bound, false, (symbol) => symbols.push(symbol)).check();
  return symbols;
}

export function diagnoseSource(source: string, modeOrOptions: TypecheckMode | CheckSourceOptions = "warn"): Diagnostic[] {
  const options = checkOptions(modeOrOptions);
  if (options.mode === "off") return [];
  try {
    return checkSource(source, options);
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
