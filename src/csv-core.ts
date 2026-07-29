export type CsvCell = string | number;
export type CsvRow = CsvCell[];

export type CsvFinishResult = {
  rowCount: number;
  headers: CsvRow;
};

export class CsvStreamParser {
  separator: string;
  pending: CsvRow[];
  buffer: string;
  headers: CsvRow | null;
  rowCount: number;

  constructor(separator = ",") {
    this.separator = separator;
    this.pending = [];
    this.buffer = "";
    this.headers = null;
    this.rowCount = 0;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let index = 0;
    let start = 0;
    let quoted = false;
    while (index < this.buffer.length) {
      const ch = this.buffer[index];
      if (ch === "\"") {
        if (quoted && this.buffer[index + 1] === "\"") index++;
        else quoted = !quoted;
      } else if (!quoted && (ch === "\n" || ch === "\r")) {
        this.pushLine(this.buffer.slice(start, index));
        if (ch === "\r" && this.buffer[index + 1] === "\n") index++;
        start = index + 1;
      }
      index++;
    }
    this.buffer = this.buffer.slice(start);
  }

  finish(): CsvFinishResult {
    if (this.buffer.length) this.pushLine(this.buffer);
    this.buffer = "";
    return { rowCount: this.rowCount, headers: this.headers || [] };
  }

  drain(): CsvRow[] {
    const rows = this.pending;
    this.pending = [];
    return rows;
  }

  pushLine(line: string): void {
    if (!line && !this.headers) return;
    const row = parseCsvLine(line, this.separator);
    if (!this.headers) {
      this.headers = row;
      this.pending.push(row);
      return;
    }
    this.pending.push(row);
    this.rowCount++;
  }
}

function parseCsvLine(line: string, separator: string): CsvRow {
  const out: CsvRow = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (quoted && line[i + 1] === "\"") {
        value += "\"";
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && ch === separator) {
      out.push(coerce(value));
      value = "";
    } else {
      value += ch;
    }
  }
  out.push(coerce(value));
  return out;
}

function coerce(value: string): CsvCell {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const numeric = Number(trimmed);
  return Number.isNaN(numeric) ? value : numeric;
}
