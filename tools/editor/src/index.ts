export { TeraEditor } from "./TeraEditor";
export type { TeraEditorHandle, TeraEditorProps } from "./TeraEditor";
export { TERA_BASIC_SETUP } from "./setup";
export { teraEditorTheme } from "./theme";
export { teraCodeMirrorExtensions, teraHoverDocFor } from "./extensions/tera-language";
export { makeCompletionSource } from "./extensions/completion";
export {
  applyHighlightedLine,
  highlightedLineExtension,
  revealLine,
  setHighlightedLine,
} from "./extensions/highlight-line";
export { IrEditor } from "./ir/IrEditor";
export type { IrEditorProps } from "./ir/IrEditor";
export { irCodeMirrorExtensions } from "./ir/language";
export { highlightIr } from "./ir/highlight";
export type { IrToken } from "./ir/highlight";
export { analyzeDocuments } from "./analysis/symbols";
export { diagnoseDocuments } from "./analysis/diagnostics";
export { useTeraAnalysis } from "./analysis/use-analysis";
export type { TeraAnalysis } from "./analysis/use-analysis";
export { BUILTIN_SET, KEYWORD_SET, TOKEN_RE, TYPE_SET, tokenClass } from "./highlight";
export { languageData } from "./language-data";
export type { Builtin, LanguageData, Method } from "./language-data";
export type {
  AnalysisProvider,
  DocumentContext,
  TeraDiagnostic,
  TeraDocument,
  TeraSourceAnalysis,
} from "./types";
