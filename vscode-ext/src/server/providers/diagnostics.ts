import { DiagnosticSeverity, type Connection, type Diagnostic } from "vscode-languageserver/node.js";
import { highlightSpanEnd, offsetAt, positionAt } from "tera/frontend";
import type { AnalyzedError } from "../analyzer/index.ts";
import type { DocumentAnalyzer } from "../analyzer/index.ts";
import type { ModuleWorkspace } from "../analyzer/modules.ts";
import { pathOfUri } from "../analyzer/paths.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const NOTEBOOK_CELL_SCHEME = "vscode-notebook-cell:";
const UNDEFINED_NAME = /^undefined name '(.+)'$/;
const PUBLISH_DELAY_MS = 200;

type Publisher = {
  schedule(): void;
  clear(uri: string): void;
};

export default defineProvider({
  id: "diagnostics",
  register(connection, context) {
    const publisher = createPublisher(connection, context);

    context.bus.on("analyzed", () => publisher.schedule());
    context.bus.on("refresh", () => publisher.schedule());
    context.bus.on("closed", ({ uri }) => {
      publisher.clear(uri);
      publisher.schedule();
    });
  },
});

function createPublisher(connection: Connection, context: ProviderContext): Publisher {
  const published = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    const batches = collect(context.analyzer, context.modules);
    for (const [uri, errors] of batches) {
      connection.sendDiagnostics({ uri, diagnostics: errors });
      published.add(uri);
    }
    for (const uri of [...published]) {
      if (batches.has(uri)) continue;
      connection.sendDiagnostics({ uri, diagnostics: [] });
      published.delete(uri);
    }
  };

  return {
    schedule() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, PUBLISH_DELAY_MS);
    },
    clear(uri: string) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
      published.delete(uri);
    },
  };
}

export function collect(
  analyzer: DocumentAnalyzer,
  modules: ModuleWorkspace,
): Map<string, Diagnostic[]> {
  const texts = new Map<string, string>();
  const errors = new Map<string, AnalyzedError[]>();

  const record = (uri: string, text: string, found: readonly AnalyzedError[]): void => {
    texts.set(uri, text);
    const bucket = errors.get(uri);
    if (bucket === undefined) errors.set(uri, [...found]);
    else bucket.push(...found);
  };

  for (const uri of analyzer.uris()) {
    const document = analyzer.get(uri);
    if (document === null) continue;
    const entryPath = pathOfUri(uri);
    const unresolved = entryPath === null ? [] : modules.unresolvedImports(entryPath, document.lines);
    const analysis = modules.analyze(uri);
    if (analysis === null) {
      const locals = entryPath === null
        ? new Set<string>()
        : new Set(modules.importedNames(entryPath, document.lines).map((name) => name.local));
      record(uri, document.text, [
        ...unresolved,
        ...suppressed(uri, document.errors, analyzer, locals),
      ]);
      continue;
    }
    record(uri, document.text, unresolved);
    for (const [key, found] of analysis.diagnostics) {
      const owner = analysis.documents.get(key);
      if (owner === undefined) continue;
      record(modules.uriFor(owner.path), owner.source, found);
    }
  }

  const batches = new Map<string, Diagnostic[]>();
  for (const [uri, found] of errors) {
    batches.set(uri, dedupe(found).map((error) => toDiagnostic(error, { text: texts.get(uri) ?? "" })));
  }
  return batches;
}

function dedupe(errors: readonly AnalyzedError[]): AnalyzedError[] {
  const seen = new Set<string>();
  const unique: AnalyzedError[] = [];
  for (const error of errors) {
    const key = `${error.line}:${error.column}:${error.severity}:${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(error);
  }
  return unique.sort((left, right) => left.line - right.line || left.column - right.column);
}

function suppressed(
  uri: string,
  errors: readonly AnalyzedError[],
  analyzer: DocumentAnalyzer,
  importLocals: ReadonlySet<string>,
): AnalyzedError[] {
  const names = siblingNames(uri, analyzer);
  if (names === null && importLocals.size === 0) return [...errors];
  return errors.filter((error) => {
    const match = UNDEFINED_NAME.exec(error.message);
    if (match === null) return true;
    return !importLocals.has(match[1]!) && !(names?.has(match[1]!) ?? false);
  });
}

function notebookKey(uri: string): string | null {
  return uri.startsWith(NOTEBOOK_CELL_SCHEME) ? uri.split("#")[0]! : null;
}

function siblingNames(uri: string, analyzer: DocumentAnalyzer): Set<string> | null {
  const key = notebookKey(uri);
  if (key === null) return null;

  const names = new Set<string>();
  for (const other of analyzer.uris()) {
    if (other === uri || notebookKey(other) !== key) continue;
    for (const name of analyzer.declaredNames(other)) names.add(name);
  }
  return names;
}

export function toDiagnostic(error: AnalyzedError, document: { text: string }): Diagnostic {
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
