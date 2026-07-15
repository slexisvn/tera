const NBFORMAT = 4;
const NBFORMAT_MINOR = 5;

function splitSourceLines(src) {
  const text = src || '';
  if (text === '') return [];
  const parts = text.split('\n');
  return parts.map((line, i) => (i < parts.length - 1 ? line + '\n' : line));
}

function joinSourceLines(source) {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

function serializeNotebook(cellSources) {
  const notebook = {
    nbformat: NBFORMAT,
    nbformat_minor: NBFORMAT_MINOR,
    metadata: {
      kernelspec: { name: 'tera', display_name: 'Tera' },
      language_info: { name: 'tera', file_extension: '.tera' },
    },
    cells: cellSources.map((src) => ({
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      source: splitSourceLines(src),
      outputs: [],
    })),
  };
  return JSON.stringify(notebook, null, 1);
}

function parseNotebook(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error('not valid JSON');
  }
  if (!obj || !Array.isArray(obj.cells)) throw new Error('missing cells array');
  return obj.cells.map((cell) => joinSourceLines(cell && cell.source));
}

export { serializeNotebook, parseNotebook, splitSourceLines, joinSourceLines };
