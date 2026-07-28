export { Engine } from "./api/engine.js";
export type { EngineOptions, CompileOptions, EngineValue } from "./api/engine.js";
export { buildSourceSymbolTable, checkSource, diagnoseSource, inferSymbolTypes, TypecheckError } from "./frontend/checker/index.js";
export type { Diagnostic, ScopeKind, SourceScope, SourceSymbol, SourceSymbolTable, SymbolKind, SymbolPosition, TypecheckMode, SymbolType } from "./frontend/checker/index.js";
export { recoverMemberCompletionSource } from "./frontend/editor-analysis.js";
export { tokenize } from "./frontend/lexer/offside.js";
export { KEYWORDS } from "./frontend/lexer/index.js";
export { parse } from "./frontend/parser/language.js";
export { TERA_BUILTINS, TERA_CHART_METHODS } from "../data/tera-language-spec.js";
