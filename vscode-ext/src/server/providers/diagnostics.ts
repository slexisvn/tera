import { DiagnosticSeverity, type Connection, type Diagnostic } from "vscode-languageserver/node.js";
import { highlightSpanEnd, offsetAt, positionAt } from "../../../../src/frontend/index.ts";
import type { AnalyzedDocument, AnalyzedError } from "../analyzer/index.ts";
import type { DocumentAnalyzer } from "../analyzer/index.ts";
import { defineProvider } from "./types.ts";

const NOTEBOOK_CELL_SCHEME = "vscode-notebook-cell:";
const UNDEFINED_NAME = /^undefined name '(.+)'$/;

export default defineProvider({
  id: "diagnostics",
  register(connection, context) {
    const { analyzer } = context;

    context.bus.on("analyzed", ({ uri }) => publishRelated(uri, connection, analyzer));
    context.bus.on("closed", ({ uri }) => {
      connection.sendDiagnostics({ uri, diagnostics: [] });
      publishRelated(uri, connection, analyzer, uri);
    });
  },
});

function publishRelated(uri: string, connection: Connection, analyzer: DocumentAnalyzer, skip?: string): void {
  const key = notebookKey(uri);
  if (!key) {
    if (uri !== skip) publish(uri, connection, analyzer);
    return;
  }
  for (const sibling of analyzer.uris()) {
    if (sibling !== skip && notebookKey(sibling) === key) publish(sibling, connection, analyzer);
  }
}

function publish(uri: string, connection: Connection, analyzer: DocumentAnalyzer): void {
  const document = analyzer.get(uri);
  if (!document) return;

  const siblings = siblingNames(uri, analyzer);
  const diagnostics = document.errors
    .filter((error) => !isSuppressed(error, siblings))
    .map((error) => toDiagnostic(error, document));
  connection.sendDiagnostics({ uri, diagnostics });
}

function notebookKey(uri: string): string | null {
  return uri.startsWith(NOTEBOOK_CELL_SCHEME) ? uri.split("#")[0] : null;
}

function siblingNames(uri: string, analyzer: DocumentAnalyzer): Set<string> | null {
  const key = notebookKey(uri);
  if (!key) return null;

  const names = new Set<string>();
  for (const other of analyzer.uris()) {
    if (other === uri || notebookKey(other) !== key) continue;
    for (const name of analyzer.declaredNames(other)) names.add(name);
  }
  return names;
}

function isSuppressed(error: AnalyzedError, names: Set<string> | null): boolean {
  if (!names) return false;
  const match = UNDEFINED_NAME.exec(error.message);
  return Boolean(match) && names.has(match![1]);
}

export function toDiagnostic(error: AnalyzedError, document: AnalyzedDocument): Diagnostic {
  const start = { line: Math.max(0, error.line - 1), character: Math.max(0, error.column - 1) };
  const from = offsetAt(document.text, start);
  const end = positionAt(document.text, highlightSpanEnd(document.text, from));
  return {
    severity: error.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    range: { start, end },
    message: error.message,
    source: `tera:${error.source}`,
  };
}
