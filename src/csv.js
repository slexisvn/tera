import { fs } from '#io/fs';

export function parseCsvRows(content, separator = ',') {
  const lines = splitLines(content);
  if (lines.length === 0) throw new Error('CSV file is empty');

  const headers = parseRow(lines[0], separator);
  const numCols = headers.length;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseRow(lines[i], separator);
    if (fields.length !== numCols) {
      throw new Error(`Row ${i + 1} has ${fields.length} fields, expected ${numCols}`);
    }
    const row = {};
    for (let c = 0; c < numCols; c++) row[headers[c]] = coerceValue(fields[c]);
    rows.push(row);
  }
  return { headers, rows };
}

export function loadCsvRows(filePath, separator = ',') {
  const content = fs.readFile(filePath);
  return parseCsvRows(content, separator);
}

function splitLines(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      const trimmed = current.trim();
      if (trimmed.length > 0) lines.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) lines.push(trimmed);
  return lines;
}

function parseRow(line, separator) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === separator) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function coerceValue(raw) {
  if (raw === '' || raw === 'null' || raw === 'NULL' || raw === 'NA' || raw === 'NaN') return null;
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return 1;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return 0;
  const num = Number(raw);
  if (!Number.isNaN(num)) return num;
  return raw;
}

export class CsvStreamParser {
  constructor(separator = ',') {
    this.separator = separator;
    this.inQuotes = false;
    this.line = '';
    this.headers = null;
    this.pending = [];
    this.rowCount = 0;
  }

  feed(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        this.inQuotes = !this.inQuotes;
        this.line += ch;
      } else if ((ch === '\n' || ch === '\r') && !this.inQuotes) {
        this._emitLine();
      } else {
        this.line += ch;
      }
    }
  }

  drain() {
    const rows = this.pending;
    this.pending = [];
    return rows;
  }

  finish() {
    if (this.line.length > 0) this._emitLine();
    if (!this.headers) throw new Error('CSV file is empty');
    return { headers: this.headers, rowCount: this.rowCount };
  }

  _emitLine() {
    const trimmed = this.line.trim();
    this.line = '';
    if (trimmed.length === 0) return;
    const fields = parseRow(trimmed, this.separator);
    if (!this.headers) {
      this.headers = fields;
      return;
    }
    if (fields.length !== this.headers.length) {
      throw new Error(`Row ${this.rowCount + 2} has ${fields.length} fields, expected ${this.headers.length}`);
    }
    const row = {};
    for (let c = 0; c < fields.length; c++) row[this.headers[c]] = coerceValue(fields[c]);
    this.pending.push(row);
    this.rowCount++;
  }
}
