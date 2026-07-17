import * as mlfw from "@slexisvn/mlfw";
import {
  createEngine,
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
import { register, splitOptions, type BuiltinMap } from "./common.js";

const queryEngine = createEngine();
let tableId = 0;

function dataframeFromColumns(columns: Record<string, unknown[]>): unknown {
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

export function installDataFrameBuiltins(map: BuiltinMap, metadata: Record<string, RuntimeFunctionMetadata>): void {
  register(map, "DataFrame", (...args) => dataframeFromColumns(optionsArg(args[0]) as Record<string, unknown[]>), metadata.DataFrame);
  register(map, "col", (name) => col(String(name)), metadata.col);
  register(map, "lit", (value) => lit(value as never), metadata.lit);
  register(map, "expr", (sql) => expr(String(sql)), metadata.expr);
  register(map, "sum", (column) => sum(column as never), metadata.sum);
  register(map, "avg", (column) => avg(column as never), metadata.avg);
  register(map, "min", (column) => min(column as never), metadata.min);
  register(map, "max", (column) => max(column as never), metadata.max);
  register(map, "count", (column) => count(column as never), metadata.count);
  register(map, "countStar", () => countStar(), metadata.countStar);
  register(map, "load_csv", loadCsv, metadata.load_csv);
  register(map, "register_columns_table", (columns) => tableFromColumns(optionsArg(columns) as Record<string, unknown[]>), metadata.register_columns_table);
}
