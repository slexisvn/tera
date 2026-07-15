export function formatDiagnostic(error, source, filename = null) {
  const location = filename
    ? `${filename}:${error.line ?? 1}:${error.column ?? 1}`
    : `${error.line ?? 1}:${error.column ?? 1}`;
  const lines = source.split(/\r?\n/);
  const line = lines[(error.line ?? 1) - 1];
  const header = `${error.name || 'Error'}: ${error.message}`;
  if (line === undefined) return header;
  const marker = `${' '.repeat(Math.max(0, (error.column ?? 1) - 1))}^`;
  return `${header}\n  --> ${location}\n   |\n${String(error.line ?? 1).padStart(3)}| ${line}\n   | ${marker}`;
}
