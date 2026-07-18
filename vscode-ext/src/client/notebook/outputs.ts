import { NotebookCellOutput, NotebookCellOutputItem } from "vscode";
import type { KernelValue } from "./kernel.ts";

export const CHART_MIME = "application/x-tera-chart+json";

export function buildOutputs(prints: string[], value: KernelValue | undefined): NotebookCellOutput[] {
  const outputs: NotebookCellOutput[] = [];
  if (prints.length) outputs.push(new NotebookCellOutput([NotebookCellOutputItem.stdout(prints.join("\n"))]));

  const item = buildValueItem(value);
  if (item) outputs.push(new NotebookCellOutput([item]));
  return outputs;
}

function buildValueItem(value: KernelValue | undefined): NotebookCellOutputItem | null {
  switch (value?.kind) {
    case "text":
      return NotebookCellOutputItem.text(value.text);
    case "chart":
      return NotebookCellOutputItem.json(value.spec, CHART_MIME);
    case "tensor":
      return NotebookCellOutputItem.text(value.summary);
    case "dataframe":
      return NotebookCellOutputItem.text(dataframeHtml(value), "text/html");
    default:
      return null;
  }
}

function dataframeHtml(value: Extract<KernelValue, { kind: "dataframe" }>): string {
  const head = value.columns
    .map((column) => `<th style="text-align:left;padding:2px 10px 2px 0">${escapeHtml(column)}</th>`)
    .join("");

  const body = value.rows
    .map((row) => {
      const cells = value.columns
        .map((column) => `<td style="padding:2px 10px 2px 0">${escapeHtml(row[column])}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  const more = value.total > value.rows.length
    ? `<div style="opacity:.6;margin-top:4px">${value.rows.length} of ${value.total} rows</div>`
    : "";

  return `<table style="border-collapse:collapse;font-family:var(--vscode-editor-font-family),monospace">`
    + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);
}
