import { DiagnosticSeverity } from 'vscode-languageserver';

export const id = 'diagnostics';

const NOTEBOOK_CELL_SCHEME = 'vscode-notebook-cell:';
const UNDEFINED_NAME = /^undefined name '(.+)'$/;

function notebookKey(uri) {
  return uri.startsWith(NOTEBOOK_CELL_SCHEME) ? uri.split('#')[0] : null;
}

function siblingNames(uri, analyzer) {
  const key = notebookKey(uri);
  if (!key) return null;
  const names = new Set();
  for (const other of analyzer.uris()) {
    if (other === uri || notebookKey(other) !== key) continue;
    for (const name of analyzer.declaredNames(other)) names.add(name);
  }
  return names;
}

function isSuppressed(err, names) {
  if (!names) return false;
  const match = UNDEFINED_NAME.exec(err.message ?? '');
  return Boolean(match) && names.has(match[1]);
}

function sendFor(uri, connection, analyzer) {
  const doc = analyzer.get(uri);
  if (!doc) return;
  const names = siblingNames(uri, analyzer);
  const diagnostics = doc.errors
    .filter(err => !isSuppressed(err, names))
    .map(err => toDiagnostic(err, doc));
  connection.sendDiagnostics({ uri, diagnostics });
}

export function register(connection, ctx) {
  const { analyzer } = ctx;
  ctx.bus.on('analyzed', ({ uri }) => {
    const key = notebookKey(uri);
    if (!key) {
      sendFor(uri, connection, analyzer);
      return;
    }
    for (const sibling of analyzer.uris()) {
      if (notebookKey(sibling) === key) sendFor(sibling, connection, analyzer);
    }
  });
  ctx.bus.on('closed', ({ uri }) => {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    const key = notebookKey(uri);
    if (!key) return;
    for (const sibling of analyzer.uris()) {
      if (notebookKey(sibling) === key) sendFor(sibling, connection, analyzer);
    }
  });
}

export function toDiagnostic(err, doc) {
  const line = Math.max(0, (err.line ?? 1) - 1);
  const character = Math.max(0, (err.column ?? 1) - 1);
  const end = spanEnd(doc, err.line ?? 1, err.column ?? 1) ?? { line, character: character + 1 };
  return {
    severity: DiagnosticSeverity.Error,
    range: { start: { line, character }, end },
    message: err.message,
    source: `tera:${err.source ?? 'parser'}`,
  };
}

function spanEnd(doc, line, column) {
  const token = doc?.tokens?.find(t =>
    t.line === line && t.column === column && t.endColumn !== undefined && t.type !== 'newline');
  if (!token) return null;
  return { line: (token.endLine ?? token.line) - 1, character: token.endColumn - 1 };
}
