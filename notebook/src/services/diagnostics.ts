export type NotebookDiagnostic = {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
};

export function analyzeCells(cells: { id: string; source: string }[]) {
  const ranges = new Map<string, { start: number; end: number; offset: number }>();
  let line = 1;
  let offset = 0;
  for (const cell of cells) {
    const lineCount = cell.source.split("\n").length;
    ranges.set(cell.id, { start: line, end: line + lineCount - 1, offset });
    line += lineCount;
    offset += cell.source.length + 1;
  }
  const combined = cells.map((cell) => cell.source).join("\n");
  const diagnostics = new Map<string, NotebookDiagnostic[]>();
  const raw: Array<{ line: number; column: number; message: string; severity: "error" | "warning" }> = collectLightweightDiagnostics(combined);
  for (const diagnostic of raw) {
    const owner = cells.find((cell) => {
      const range = ranges.get(cell.id);
      return range && diagnostic.line >= range.start && diagnostic.line <= range.end;
    });
    if (!owner) continue;
    const range = ranges.get(owner.id)!;
    const localLine = diagnostic.line - range.start + 1;
    const from = offsetOf(owner.source, localLine, diagnostic.column);
    const to = tokenEnd(owner.source, from);
    const list = diagnostics.get(owner.id) ?? [];
    list.push({ from, to, message: diagnostic.message.replace(/ at \d+:\d+$/, ""), severity: diagnostic.severity });
    diagnostics.set(owner.id, list);
  }
  return diagnostics;
}

function collectLightweightDiagnostics(source: string): Array<{ line: number; column: number; message: string; severity: "error" | "warning" }> {
  const diagnostics: Array<{ line: number; column: number; message: string; severity: "error" | "warning" }> = [];
  const stack: Array<{ char: string; line: number; column: number }> = [];
  const pairs = new Map<string, string>([[")", "("], ["]", "["], ["}", "{"]]);
  let line = 1;
  let column = 1;
  for (const char of source) {
    if (char === "\n") {
      line += 1;
      column = 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") stack.push({ char, line, column });
    if (pairs.has(char)) {
      const open = stack.pop();
      if (!open || open.char !== pairs.get(char)) {
        diagnostics.push({ line, column, message: `Unexpected '${char}'`, severity: "error" });
      }
    }
    column += 1;
  }
  for (const open of stack) {
    diagnostics.push({ line: open.line, column: open.column, message: `Unclosed '${open.char}'`, severity: "error" });
  }
  return diagnostics;
}

function offsetOf(text: string, line: number, column: number) {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + Math.max(0, column - 1);
}

function tokenEnd(text: string, offset: number) {
  const ch = text[offset];
  if (ch === undefined) return offset + 1;
  if (/[A-Za-z0-9_]/.test(ch)) {
    let i = offset;
    while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) i++;
    return i;
  }
  return Math.min(text.length, offset + 1);
}
