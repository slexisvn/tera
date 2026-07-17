import { memfs } from '@slexisvn/mlfw';
import { Engine } from '../../../src/index';
import type { ChartSpec, CsvRow, DataFrameRow, KernelRunResult, KernelValue } from "../types/notebook";
import type { DataFrameLike, FigureBuilderLike, KernelRequest, RuntimeLike } from "../types/kernel";
import { errorMessage } from "../types/kernel";

let runtime: RuntimeLike | null = null;
let prints: string[] = [];
let dataframeId = 0;
const dataframes = new Map<string, DataFrameLike>();
const csvBuilders = new Map<string, CsvRow[]>();

function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Map) return `Map(${value.size})`;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (hasCustomToString(value)) return value.toString();
  return JSON.stringify(value);
}

function hasCustomToString(value: unknown): value is { toString(): string } {
  return typeof value === "object" && value !== null && typeof value.toString === "function" && value.toString !== Object.prototype.toString;
}

function isTensor(value: unknown): value is { shape: unknown; toArray(): unknown; toString(): string } {
  return typeof value === "object" && value !== null
    && Array.isArray((value as { shape?: unknown }).shape)
    && typeof (value as { toArray?: unknown }).toArray === "function";
}

function makeRuntime(): void {
  prints = [];
  dataframes.clear();
  dataframeId = 0;
  csvBuilders.clear();
  runtime = new Engine({ output: (text: unknown) => prints.push(String(text)) }) as RuntimeLike;
}

makeRuntime();

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const { id, type, payload } = event.data;
  try {
    let result: unknown;
    if (type === 'execute') result = await execute(payload.source);
    else if (type === 'restart') result = restart();
    else if (type === 'completionNames') result = completionNames();
    else if (type === 'beginCsv') result = beginCsv(payload.name);
    else if (type === 'appendCsvRows') result = appendCsvRows(payload.name, payload.rows);
    else if (type === 'finishCsv') result = finishCsv(payload.name);
    else if (type === 'writeFile') result = writeFile(payload);
    else if (type === 'removeFile') result = removeFile(payload.name, payload.kind);
    else if (type === 'dataframePage') result = await dataframePage(payload.id, payload.offset, payload.limit);
    else throw new Error(`Unknown kernel message '${type}'`);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: errorMessage(error) });
  }
};

async function execute(source: string): Promise<KernelRunResult> {
  if (!runtime) throw new Error("Kernel runtime is not initialized");
  prints = [];
  const value = await Promise.resolve(runtime.runNative(source));
  return {
    prints: prints.slice(),
    value: await serializeValue(value),
    completionNames: completionNames(),
  };
}

function restart(): { completionNames: string[] } {
  makeRuntime();
  return { completionNames: completionNames() };
}

function completionNames(): string[] {
  if (!runtime) return [];
  return Array.from(runtime.interpreter.globalCells.cells.keys()).sort();
}

function beginCsv(name: string): boolean {
  csvBuilders.set(name, []);
  return true;
}

function appendCsvRows(name: string, rows: CsvRow[]): boolean {
  const builder = csvBuilders.get(name);
  if (!builder) throw new Error(`CSV upload not started: ${name}`);
  builder.push(...rows);
  return true;
}

function finishCsv(name: string): boolean {
  const builder = csvBuilders.get(name);
  if (!builder) throw new Error(`CSV upload not started: ${name}`);
  const text = builder.map((row: CsvRow) => row.map((cell) => String(cell ?? '')).join(',')).join('\n');
  memfs.writeFile(name, text);
  csvBuilders.delete(name);
  return true;
}

function writeFile({ name, data, binary }: { name: string; data: string | ArrayBuffer; binary: boolean }): boolean {
  if (binary) {
    if (typeof data === "string") throw new Error("Binary file payload must be an ArrayBuffer");
    memfs.writeBinary(name, new Uint8Array(data));
  } else {
    if (typeof data !== "string") throw new Error("Text file payload must be a string");
    memfs.writeFile(name, data);
  }
  return true;
}

function removeFile(name: string, kind: string): boolean {
  memfs.remove(name);
  return true;
}

async function serializeValue(value: unknown): Promise<KernelValue> {
  if (value === undefined) return { kind: 'empty' };
  if (isFigureBuilder(value)) value = await value.build();
  if (isChartSpec(value)) return { kind: 'chart', spec: value as ChartSpec };
  if (isTensor(value)) {
    return {
      kind: 'tensor',
      shape: value.shape as number[],
      data: value.toArray(),
      summary: hasCustomToString(value) ? value.toString() : `Tensor(shape=${JSON.stringify(value.shape)})`,
    };
  }
  if (isDataFrame(value)) {
    const id = `df-${++dataframeId}`;
    dataframes.set(id, value);
    const columns = await value.columns();
    const total = await value.count();
    return { kind: 'dataframe', id, columns, total };
  }
  return { kind: 'text', text: formatValue(value) };
}

async function dataframePage(id: string, offset = 0, limit = 25): Promise<{ rows: DataFrameRow[] }> {
  const df = dataframes.get(id);
  if (!df) throw new Error('DataFrame result expired');
  const rows = await df.limit(limit, offset).collect();
  return { rows };
}

function isDataFrame(value: unknown): value is DataFrameLike {
  return typeof value === "object" && value !== null
    && typeof (value as { limit?: unknown }).limit === "function"
    && typeof (value as { columns?: unknown }).columns === "function"
    && typeof (value as { count?: unknown }).count === "function";
}

function isFigureBuilder(value: unknown): value is FigureBuilderLike {
  return typeof value === "object" && value !== null
    && (value as { __isFigureBuilder?: unknown }).__isFigureBuilder === true
    && typeof (value as { build?: unknown }).build === "function";
}

function isChartSpec(value: unknown): value is ChartSpec {
  return typeof value === "object" && value !== null
    && ((value as { kind?: unknown }).kind === "chart" || typeof (value as { type?: unknown }).type === "string");
}
