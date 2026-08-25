const NBFORMAT = 4;
const NBFORMAT_MINOR = 5;

type NotebookCellSource = string | string[];

type NotebookCell = {
  source?: NotebookCellSource;
};

type NotebookFile = {
  cells: NotebookCell[];
};

function isNotebookFile(value: unknown): value is NotebookFile {
  return typeof value === "object" && value !== null && Array.isArray((value as { cells?: unknown }).cells);
}

function splitSourceLines(src: string): string[] {
  const text = src || '';
  if (text === '') return [];
  const parts = text.split('\n');
  return parts.map((line: string, i: number) => (i < parts.length - 1 ? line + '\n' : line));
}

function joinSourceLines(source: unknown): string {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

function serializeNotebook(cellSources: string[]): string {
  const notebook = {
    nbformat: NBFORMAT,
    nbformat_minor: NBFORMAT_MINOR,
    metadata: {
      kernelspec: { name: 'tera', display_name: 'Tera' },
      language_info: { name: 'tera', file_extension: '.tera' },
    },
    cells: cellSources.map((src: string) => ({
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      source: splitSourceLines(src),
      outputs: [],
    })),
  };
  return JSON.stringify(notebook, null, 1);
}

function parseNotebook(text: string): string[] {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error('not valid JSON');
  }
  if (!isNotebookFile(obj)) throw new Error('missing cells array');
  return obj.cells.map((cell: NotebookCell) => joinSourceLines(cell.source));
}

export { serializeNotebook, parseNotebook, splitSourceLines, joinSourceLines };
