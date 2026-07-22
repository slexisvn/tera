import * as mlfw from "@slexisvn/mlfw";
import {
  createEngine,
  DataFrame,
  InMemoryRelation,
  col,
  lit,
  expr,
  sum,
  avg,
  min,
  max,
  count,
  countStar,
} from "@slexisvn/query-engine";
import type { RuntimeFunctionMetadata } from "../../core/value/index.js";
import { optionsArg } from "./host.js";
import { register, splitOptions, type BuiltinMap, type NativeFn } from "./common.js";

const makeTensor = (mlfw as Record<string, unknown>).tensor as NativeFn;

const queryEngine = createEngine();
let tableId = 0;

export function dataframeFromColumns(columns: Record<string, unknown[]>): unknown {
  const names = Object.keys(columns);
  if (names.length === 0) throw new Error("DataFrame() requires named column arrays, e.g. DataFrame(name=[...], age=[...])");
  const length = columns[names[0]!]!.length;
  const rows = new Array(length);
  const matrix = new Array(length);
  for (let rowIndex = 0; rowIndex < length; rowIndex++) {
    const row: Record<string, unknown> = {};
    for (const name of names) row[name] = columns[name]![rowIndex];
    rows[rowIndex] = row;
    matrix[rowIndex] = names.map((name) => columns[name]![rowIndex]);
  }
  const df = queryEngine.createDataFrame(rows) as unknown as Record<string, unknown>;
  Object.defineProperty(df, "__columns", { value: names, enumerable: false });
  Object.defineProperty(df, "__rows", { value: rows, enumerable: false });
  Object.defineProperty(df, "__matrix", { value: matrix, enumerable: false });
  return df;
}

function tableFromColumns(columns: Record<string, unknown[]>): string {
  const relation = InMemoryRelation.fromColumns(columns as never);
  const name = `__table_${tableId++}`;
  queryEngine.catalog.registerTable(name, relation.getSchema());
  queryEngine.catalog.registerTableStorage(name, relation as never);
  return name;
}

function loadCsv(path: unknown, ...args: unknown[]): unknown {
  if (typeof path !== "string") throw new Error("load_csv() requires a file path string");
  const { options } = splitOptions(args);
  const sep = String(options.separator ?? options.sep ?? ",");
  const data = (mlfw.memfs as { readFile(path: string): string | Uint8Array }).readFile(path);
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(sep);
  const rows = lines.map((line) => {
    const values = line.split(sep);
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) row[columns[i]!] = Number.isNaN(Number(values[i])) ? values[i] : Number(values[i]);
    return row;
  });
  return queryEngine.createDataFrame(rows as never);
}

type Frame = {
  columns(): string[];
  collect(): Promise<Array<Record<string, unknown>>>;
  toArray(): Promise<unknown>;
  select(...columns: string[]): Frame;
  limit(count: number): Frame;
};

export function isDataFrame(value: unknown): boolean {
  return value instanceof DataFrame;
}

function numericColumns(frame: Frame, rows: Array<Record<string, unknown>>): string[] {
  const columns = frame.columns();
  if (rows.length === 0) return columns;
  return columns.filter((name) => typeof rows[0]![name] === "number");
}

export async function framePanel(value: unknown, columns?: string[]): Promise<number[][]> {
  const frame = value as Frame;
  const rows = await frame.collect();
  const names = columns ?? numericColumns(frame, rows);
  return rows.map((row) => names.map((name) => Number(row[name])));
}

async function frameMatrix(frame: Frame, columns: string[]): Promise<{ names: string[]; rows: Array<Record<string, unknown>> }> {
  const selected = columns.length > 0 ? frame.select(...columns) : frame;
  return { names: selected.columns(), rows: await selected.collect() };
}

async function frameToTensor(frame: Frame, columns: string[]): Promise<unknown> {
  const { names, rows } = await frameMatrix(frame, columns);
  const width = names.length;
  const flat = new Float32Array(rows.length * width);
  let cursor = 0;
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < width; column++) {
      const value = rows[row]![names[column]!];
      if (typeof value !== "number") {
        throw new Error(`Column '${names[column]}' contains non-numeric value '${value}' at row ${row}. Use encode() for categorical columns.`);
      }
      flat[cursor++] = value;
    }
  }
  return makeTensor(flat, { shape: [rows.length, width] });
}

async function frameEncode(frame: Frame, column: unknown, known: unknown): Promise<unknown[]> {
  const rows = await frame.collect();
  const name = typeof column === "string" ? column : frame.columns()[0]!;
  const classes = Array.isArray(known) ? [...known] : [];
  const indexByClass = new Map(classes.map((value, index) => [String(value), index]));
  const encoded = new Float32Array(rows.length);
  for (let row = 0; row < rows.length; row++) {
    const value = rows[row]![name];
    const key = String(value);
    let index = indexByClass.get(key);
    if (index === undefined) {
      if (Array.isArray(known)) throw new Error(`Unknown class '${value}' not present in fitted classes`);
      index = classes.length;
      indexByClass.set(key, index);
      classes.push(value);
    }
    encoded[row] = index;
  }
  return [makeTensor(encoded, { shape: [rows.length] }), classes];
}

function installFrameMethods(): void {
  const proto = DataFrame.prototype as unknown as Record<string, unknown>;
  proto.toString = function (this: Frame) {
    return `DataFrame(${this.columns().join(", ")})`;
  };
  proto.head = function (this: Frame, count: unknown) {
    return this.limit(typeof count === "number" ? count : 5);
  };
  proto.toTensor = function (this: Frame, ...columns: unknown[]) {
    return frameToTensor(this, columns.filter((column): column is string => typeof column === "string"));
  };
  proto.to_tensor = proto.toTensor;
  proto.to_array = function (this: Frame) {
    return this.toArray();
  };
  proto.encode = function (this: Frame, column: unknown, ...rest: unknown[]) {
    const { values, options } = splitOptions(rest);
    return frameEncode(this, column, options.classes ?? values[0] ?? null);
  };
}

export function installDataFrameBuiltins(map: BuiltinMap, metadata: Record<string, RuntimeFunctionMetadata>): void {
  installFrameMethods();
  register(map, "DataFrame", (...args) => dataframeFromColumns(optionsArg(args[0]) as Record<string, unknown[]>), metadata.DataFrame);
  register(map, "col", (name) => col(String(name)), metadata.col);
  register(map, "lit", (value) => lit(value as never), metadata.lit);
  register(map, "expr", (sql) => expr(String(sql)), metadata.expr);
  register(map, "sum", (column) => sum(column as never), metadata.sum);
  register(map, "avg", (column) => avg(column as never), metadata.avg);
  register(map, "min", (column) => min(column as never), metadata.min);
  register(map, "max", (column) => max(column as never), metadata.max);
  register(map, "count", (column) => count(column as never), metadata.count);
  register(map, "count_star", () => countStar(), metadata.count_star);
  register(map, "load_csv", loadCsv, metadata.load_csv);
  register(map, "register_columns_table", (columns) => tableFromColumns(optionsArg(columns) as Record<string, unknown[]>), metadata.register_columns_table);
}
