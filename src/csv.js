import { memfs as fs } from '@slexisvn/mlfw';
import { parseCsvRows } from './csv-core.js';

export { CsvStreamParser, parseCsvRows } from './csv-core.js';

export function loadCsvRows(filePath, separator = ',') {
  const content = fs.readFile(filePath);
  return parseCsvRows(content, separator);
}
