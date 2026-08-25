import { createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import { diagnoseSource, highlightSpanEnd, type Diagnostic } from "tera/frontend";
import type { TeraDiagnostic, TeraDocument } from "../types";

export function diagnoseDocuments(documents: readonly TeraDocument[]): Map<string, TeraDiagnostic[]> {
  const ranges: DocumentRange[] = [];
  let line = 1;
  for (const document of documents) {
    const lineCount = document.source.split("\n").length;
    ranges.push({
      id: document.id,
      source: document.source,
      start: line,
      end: line + lineCount - 1,
      lineStarts: lineStarts(document.source),
    });
    line += lineCount;
  }
  const combined = documents.map((document) => document.source).join("\n");
  const diagnostics = new Map<string, TeraDiagnostic[]>();
  const raw = [...diagnoseSource(combined, createReactiveCheckOptions())].sort(compareDiagnostics);
  for (const diagnostic of raw) {
    const range = rangeForLine(ranges, diagnostic.line);
    if (!range) continue;
    const localLine = diagnostic.line - range.start + 1;
    const from = offsetOf(range.lineStarts, localLine, diagnostic.column);
    const to = highlightSpanEnd(range.source, from);
    const list = diagnostics.get(range.id) ?? [];
    list.push({ from, to, message: diagnostic.message.replace(/ at \d+:\d+$/, ""), severity: diagnostic.severity });
    diagnostics.set(range.id, list);
  }
  return diagnostics;
}

type DocumentRange = {
  id: string;
  source: string;
  start: number;
  end: number;
  lineStarts: number[];
};

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return left.line - right.line || left.column - right.column;
}

function rangeForLine(ranges: DocumentRange[], line: number): DocumentRange | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const range = ranges[mid];
    if (line < range.start) high = mid - 1;
    else if (line > range.end) low = mid + 1;
    else return range;
  }
  return null;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetOf(starts: number[], line: number, column: number) {
  return (starts[line - 1] ?? 0) + Math.max(0, column - 1);
}
