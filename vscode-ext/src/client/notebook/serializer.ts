import {
  NotebookCellData, NotebookCellKind, NotebookData,
  type NotebookSerializer,
} from "vscode";

export const NOTEBOOK_TYPE = "tera-notebook";

type SerializedCell = { source?: string | string[] };

type SerializedNotebook = { cells?: SerializedCell[] };

export const serializer: NotebookSerializer = {
  deserializeNotebook(content) {
    const parsed = parse(new TextDecoder().decode(content));
    const cells = (parsed?.cells ?? []).map(
      (cell) => new NotebookCellData(NotebookCellKind.Code, joinSource(cell.source), "tera"),
    );
    return new NotebookData(cells);
  },

  serializeNotebook(data) {
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { name: "tera", display_name: "Tera" },
        language_info: { name: "tera", file_extension: ".tera" },
      },
      cells: data.cells.map((cell) => ({
        cell_type: "code",
        execution_count: null,
        metadata: {},
        source: splitSource(cell.value),
        outputs: [],
      })),
    };
    return new TextEncoder().encode(JSON.stringify(notebook, null, 1));
  },
};

function parse(text: string): SerializedNotebook | null {
  try {
    const parsed = JSON.parse(text) as SerializedNotebook;
    return Array.isArray(parsed?.cells) ? parsed : null;
  } catch {
    return null;
  }
}

function joinSource(source: SerializedCell["source"]): string {
  if (Array.isArray(source)) return source.join("");
  return typeof source === "string" ? source : "";
}

function splitSource(text: string): string[] {
  if (!text) return [];
  const parts = text.split("\n");
  return parts.map((line, index) => (index < parts.length - 1 ? `${line}\n` : line));
}
