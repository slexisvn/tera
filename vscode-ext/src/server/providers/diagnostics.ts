import { DiagnosticSeverity, type Connection, type Diagnostic } from "vscode-languageserver/node.js";
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
  const line = Math.max(0, error.line - 1);
  const character = Math.max(0, error.column - 1);
  return {
    severity: error.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    range: {
      start: { line, character },
      end: spanEnd(document, error.line, error.column) ?? { line, character: character + 1 },
    },
    message: error.message,
    source: `tera:${error.source}`,
  };
}

function spanEnd(document: AnalyzedDocument, line: number, column: number) {
  const token = document.tokens.find((candidate) => candidate.line === line && candidate.column === column);
  if (!token) return null;
  return { line: token.endLine - 1, character: token.endColumn - 1 };
}
