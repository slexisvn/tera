export { KEYWORDS, Lexer, TokenType } from "./lexer/index.js";
export type { Token, TokenTypeName, TokenValue } from "./lexer/index.js";
export { tokenize } from "./lexer/offside.js";
export { parse } from "./parser/language.js";
export { Parser } from "./parser/index.js";
export type { ParserOptions } from "./parser/index.js";
export type { ParserCheckpoint, ParserContext, StatementParseResult, SyntaxPlugin, SyntaxTransformContext } from "./parser/extensions.js";
export { applySyntaxTransforms } from "./parser/extensions.js";
export { buildSourceSymbolTable, checkSource, diagnoseSource, inferSymbolTypes, TypecheckError } from "./checker/index.js";
export type { BindOptions, CheckSourceOptions, Diagnostic, ExternalBuiltinParam, ExternalBuiltinSignature, ExternalInterface, ExternalInterfaceField, ExternalTypeAlias, ScopeKind, SourceScope, SourceSymbol, SourceSymbolTable, SymbolKind, SymbolPosition, TypecheckMode, SymbolType } from "./checker/index.js";
export { buildLanguageData, buildLanguageDataFromSpec, collectLanguageDataSource, parseParams } from "./language-data.js";
export {
  extractReceiverExpression,
  highlightSpanEnd,
  isMemberAccessSource,
  isStringLiteralTextOffset,
  isStringLiteralTextPosition,
  offsetAt,
  positionAt,
  recoverMemberCompletionSource,
  resolveMemberReceiverType,
  stringLiteralTextPredicate,
  stringLiteralTextRanges,
} from "./editor-analysis.js";
export type { Builtin, BuiltinSource, KeywordGroup, LanguageData, LanguageDataSource, LanguageDataSpec, Method, Operators, Param, PseudoTypeSource, Signature } from "./language-data.js";
export * from "./ast/index.js";
export { CLASS_ABSTRACT_MODIFIER, CLASS_MEMBER_MODIFIER_KEYWORDS, CLASS_MEMBER_MODIFIERS, CLASS_STATIC_MODIFIER, CLASS_VISIBILITIES, CLASS_VISIBILITY_KEYWORDS, DEFAULT_CLASS_VISIBILITY, isClassVisibility } from "../core/class-visibility.js";
export type { ClassVisibility } from "../core/class-visibility.js";
