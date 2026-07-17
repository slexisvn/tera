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
import * as quantc from "@slexisvn/quantc";
import type { RuntimeFunctionPayload } from "../../core/value/index.js";
import { hostBuiltin, optionsArg } from "./host.js";
import { createModelBuiltins } from "./model-builtins.js";
import { CHART_METADATA, DOMAIN_BUILTIN_METADATA } from "./metadata.js";

type BuiltinMap = Record<string, RuntimeFunctionPayload>;
type NativeFn = (...args: unknown[]) => unknown;
const ml = mlfw as Record<string, unknown>;
const quant = quantc as Record<string, unknown>;

const queryEngine = createEngine();
let tableId = 0;

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelOptions(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) out[snakeToCamel(key)] = value;
  return out;
}

function splitOptions(args: unknown[]): { values: unknown[]; options: Record<string, unknown> } {
  const values = args.slice();
  const last = values[values.length - 1];
  const options = optionsArg(last);
  if (Object.keys(options).length > 0 && last === options) values.pop();
  return { values, options };
}

function construct(Cls: new (...args: unknown[]) => unknown): NativeFn {
  return (...args) => {
    const { values, options } = splitOptions(args);
    return new Cls(...values, ...Object.keys(options).length > 0 ? [camelOptions(options)] : []);
  };
}

function callWithOptions(fn: NativeFn): NativeFn {
  return (...args) => {
    const { values, options } = splitOptions(args);
    return fn(...values, ...Object.keys(options).length > 0 ? [camelOptions(options)] : []);
  };
}

function register(map: BuiltinMap, name: string, fn: NativeFn): void {
  map[name] = hostBuiltin(name, fn, DOMAIN_BUILTIN_METADATA[name]);
}

function dataframeFromColumns(columns: Record<string, unknown[]>): unknown {
  const names = Object.keys(columns);
  if (names.length === 0) throw new Error("DataFrame() requires named columns");
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

function createChartSpec(type: string, data: unknown, options: Record<string, unknown>): unknown {
  const series = type === "histogram" ? histogramSeries(data, options) : arraySeries(data, options);
  const pointCount = series.reduce((sum, item) => sum + item.points.length, 0);
  return {
    kind: "tera.notebook.chart",
    type,
    series,
    pointCount,
    options: normalizeChartOptions(options),
  };
}

function numeric(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} contains non-numeric value '${String(value)}'`);
  return number;
}

function tensorArray(data: unknown): unknown {
  if (data && typeof data === "object" && typeof (data as { toArray?: unknown }).toArray === "function") {
    return (data as { toArray(): unknown }).toArray();
  }
  return data;
}

function priceMatrix(data: unknown): unknown {
  if (data && typeof data === "object" && Array.isArray((data as { __matrix?: unknown }).__matrix)) {
    return (data as { __matrix: unknown[] }).__matrix.map((row) => {
      if (!Array.isArray(row)) return row;
      return row.map((value) => {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`price matrix contains non-numeric value '${String(value)}'`);
        return number;
      });
    });
  }
  return data;
}

function quantFunction(name: unknown, fallback: string, ...args: unknown[]): unknown {
  if (typeof name === "function") return name;
  const aliases: Record<string, string> = {
    long_short: "longShortRank",
    mean_reversion: "meanReversion",
    equal_weight: "equalWeight",
    risk_parity: "riskParity",
    mean_variance: "meanVariance",
    cross_sectional: "crossSectional",
  };
  const key = typeof name === "string" ? aliases[name] ?? snakeToCamel(name) : fallback;
  const candidate = quant[key];
  if (typeof candidate !== "function") throw new Error(`Unknown quant function '${String(name)}'`);
  return (candidate as NativeFn)(...args);
}

function normalizeIndexSelection(value: unknown, width: number): number[] {
  if (value === undefined || value === null) return Array.from({ length: width }, (_, index) => index);
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    const index = Number(item);
    if (!Number.isInteger(index) || index < 0 || index >= width) throw new Error(`Chart column index must be between 0 and ${width - 1}`);
    return index;
  });
}

function dataFrameRows(data: unknown): Record<string, unknown>[] | null {
  if (!data || typeof data !== "object") return null;
  const rows = (data as { __rows?: unknown }).__rows;
  if (!Array.isArray(rows)) return null;
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
}

function dataFrameColumns(data: unknown, rows: Record<string, unknown>[]): string[] {
  const columns = (data as { __columns?: unknown }).__columns;
  if (Array.isArray(columns) && columns.every((name) => typeof name === "string")) return columns;
  return Object.keys(rows[0] ?? {});
}

function normalizeColumnSelection(value: unknown, columns: string[], label: string): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const names = values.map((item) => String(item));
  for (const name of names) {
    if (!columns.includes(name)) throw new Error(`Chart ${label} column '${name}' does not exist`);
  }
  return names;
}

function dataFrameSeries(data: unknown, options: Record<string, unknown>): Array<{ name: string; points: Array<Record<string, unknown>> }> | null {
  const rows = dataFrameRows(data);
  if (!rows) return null;
  const columns = dataFrameColumns(data, rows);
  const xName = options.x === undefined || options.x === null ? null : String(options.x);
  if (xName && !columns.includes(xName)) throw new Error(`Chart x column '${xName}' does not exist`);
  const yNames = normalizeColumnSelection(options.y, columns, "y");
  const selectedY = yNames.length ? yNames : columns.filter((name) => name !== xName);
  if (selectedY.length === 0) return [{ name: "value", points: [] }];
  return selectedY.map((name) => {
    const points: Array<Record<string, unknown>> = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const y = numeric(row[name], `Column ${name}`);
      if (y === null) continue;
      points.push({ x: xName ? row[xName] : rowIndex, y });
    }
    return { name, points };
  });
}

function arraySeries(data: unknown, options: Record<string, unknown>): Array<{ name: string; points: Array<Record<string, unknown>> }> {
  const frameSeries = dataFrameSeries(data, options);
  if (frameSeries) return frameSeries;
  const values = tensorArray(data);
  if (!Array.isArray(values)) {
    return [{ name: String(options.y ?? "value"), points: [] }];
  }
  if (values.length === 0) return [{ name: "value", points: [] }];
  if (!Array.isArray(values[0])) {
    const points = values
      .map((value, index) => {
        const y = numeric(value, "Array value");
        return y === null ? null : { x: index, y };
      })
      .filter((point): point is { x: number; y: number } => point !== null);
    return [{ name: String(options.y ?? "value"), points }];
  }
  const rows = values as unknown[][];
  const width = rows[0]?.length ?? 0;
  const xIndex = options.x === undefined || options.x === null ? null : Number(options.x);
  const yIndexes = normalizeIndexSelection(options.y, width);
  return yIndexes.map((yIndex) => {
    const points: Array<Record<string, unknown>> = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!Array.isArray(row) || row.length !== width) throw new Error("Chart array rows must have equal length");
      const y = numeric(row[yIndex], `Column ${yIndex}`);
      if (y === null) continue;
      const x = xIndex === null ? rowIndex : row[xIndex];
      points.push({ x, y });
    }
    return { name: `column ${yIndex}`, points };
  });
}

function flattenNumbers(value: unknown, out: number[]): void {
  const data = tensorArray(value);
  if (Array.isArray(data)) {
    for (const item of data) flattenNumbers(item, out);
    return;
  }
  const number = numeric(data, "Histogram data");
  if (number !== null) out.push(number);
}

function histogramSeries(data: unknown, options: Record<string, unknown>): Array<{ name: string; points: Array<Record<string, number>> }> {
  const values: number[] = [];
  flattenNumbers(data, values);
  const bins = Number(options.bins ?? 20);
  if (!Number.isInteger(bins) || bins < 1 || bins > 200) throw new Error("histogram bins must be an integer between 1 and 200");
  if (values.length === 0) return [{ name: "value", points: [] }];
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (minValue === maxValue) {
    minValue -= 0.5;
    maxValue += 0.5;
  }
  const step = (maxValue - minValue) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const value of values) counts[Math.min(bins - 1, Math.floor((value - minValue) / step))]++;
  return [{
    name: "value",
    points: counts.map((countValue, index) => {
      const x0 = minValue + index * step;
      const x1 = x0 + step;
      return { x: (x0 + x1) / 2, y: countValue, x0, x1 };
    }),
  }];
}

function normalizeChartOptions(options: Record<string, unknown>): Record<string, unknown> {
  return {
    title: options.title ?? null,
    xLabel: options.x_label ?? options.xLabel ?? null,
    yLabel: options.y_label ?? options.yLabel ?? null,
    legend: options.legend !== false,
    zoom: options.zoom !== false,
    mode: options.mode ?? null,
    dash: options.dash === true,
    animate: options.animate === true,
  };
}

function installTensorBuiltins(map: BuiltinMap): void {
  const factories: Record<string, NativeFn> = {
    tensor: ml.tensor as NativeFn,
    zeros: ml.zeros as NativeFn,
    ones: ml.ones as NativeFn,
    empty: ml.empty as NativeFn,
    full: ml.full as NativeFn,
    randn: ml.randn as NativeFn,
    arange: ml.arange as NativeFn,
    eye: ml.eye as NativeFn,
    linspace: ml.linspace as NativeFn,
    randperm: ml.randperm as NativeFn,
    zerosLike: ml.zerosLike as NativeFn,
    onesLike: ml.onesLike as NativeFn,
    emptyLike: ml.emptyLike as NativeFn,
    fullLike: ml.fullLike as NativeFn,
    randnLike: ml.randnLike as NativeFn,
    where: ml.where as NativeFn,
    cat: ml.cat as NativeFn,
    stack: ml.stack as NativeFn,
  };
  for (const [name, fn] of Object.entries(factories)) register(map, name, callWithOptions(fn));
  const modules: Record<string, new (...args: unknown[]) => unknown> = {
    Linear: ml.Linear as new (...args: unknown[]) => unknown,
    ReLU: ml.ReLU as new (...args: unknown[]) => unknown,
    GELU: ml.GELU as new (...args: unknown[]) => unknown,
    SiLU: ml.SiLU as new (...args: unknown[]) => unknown,
    Sigmoid: ml.Sigmoid as new (...args: unknown[]) => unknown,
    Tanh: ml.Tanh as new (...args: unknown[]) => unknown,
    LeakyReLU: ml.LeakyReLU as new (...args: unknown[]) => unknown,
    ELU: ml.ELU as new (...args: unknown[]) => unknown,
    Softmax: ml.Softmax as new (...args: unknown[]) => unknown,
    LogSoftmax: ml.LogSoftmax as new (...args: unknown[]) => unknown,
    Flatten: ml.Flatten as new (...args: unknown[]) => unknown,
    Dropout: ml.Dropout as new (...args: unknown[]) => unknown,
    LayerNorm: ml.LayerNorm as new (...args: unknown[]) => unknown,
    BatchNorm1d: ml.BatchNorm1d as new (...args: unknown[]) => unknown,
    BatchNorm2d: ml.BatchNorm2d as new (...args: unknown[]) => unknown,
    Conv1d: ml.Conv1d as new (...args: unknown[]) => unknown,
    Conv2d: ml.Conv2d as new (...args: unknown[]) => unknown,
    MaxPool2d: ml.MaxPool2d as new (...args: unknown[]) => unknown,
    AvgPool2d: ml.AvgPool2d as new (...args: unknown[]) => unknown,
    AdaptiveAvgPool2d: ml.AdaptiveAvgPool2d as new (...args: unknown[]) => unknown,
    Embedding: ml.Embedding as new (...args: unknown[]) => unknown,
    GRU: ml.GRU as new (...args: unknown[]) => unknown,
    GRUCell: ml.GRUCell as new (...args: unknown[]) => unknown,
    LSTM: ml.LSTM as new (...args: unknown[]) => unknown,
    LSTMCell: ml.LSTMCell as new (...args: unknown[]) => unknown,
    CrossEntropyLoss: ml.CrossEntropyLoss as new (...args: unknown[]) => unknown,
    MSELoss: ml.MSELoss as new (...args: unknown[]) => unknown,
    NLLLoss: ml.NLLLoss as new (...args: unknown[]) => unknown,
    BCELoss: ml.BCELoss as new (...args: unknown[]) => unknown,
    Sequential: ml.Sequential as new (...args: unknown[]) => unknown,
    DataLoader: ml.DataLoader as new (...args: unknown[]) => unknown,
    TensorDataset: ml.TensorDataset as new (...args: unknown[]) => unknown,
    SGD: ml.SGD as new (...args: unknown[]) => unknown,
    Adam: ml.Adam as new (...args: unknown[]) => unknown,
    AdamW: ml.AdamW as new (...args: unknown[]) => unknown,
  };
  for (const [name, cls] of Object.entries(modules)) register(map, name, construct(cls));
}

function installDataFrameBuiltins(map: BuiltinMap): void {
  register(map, "DataFrame", (...args) => dataframeFromColumns(optionsArg(args[0]) as Record<string, unknown[]>));
  register(map, "col", (name) => col(String(name)));
  register(map, "lit", (value) => lit(value as never));
  register(map, "expr", (sql) => expr(String(sql)));
  register(map, "sum", (column) => sum(column as never));
  register(map, "avg", (column) => avg(column as never));
  register(map, "min", (column) => min(column as never));
  register(map, "max", (column) => max(column as never));
  register(map, "count", (column) => count(column as never));
  register(map, "countStar", () => countStar());
  register(map, "load_csv", (path) => {
    const data = (ml.memfs as { readFile(path: string): string | Uint8Array }).readFile(String(path));
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const [header, ...lines] = text.trim().split(/\r?\n/);
    const columns = header.split(",");
    const rows = lines.map((line) => {
      const values = line.split(",");
      const row: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) row[columns[i]!] = Number.isNaN(Number(values[i])) ? values[i] : Number(values[i]);
      return row;
    });
    return queryEngine.createDataFrame(rows as never);
  });
  register(map, "register_columns_table", (columns) => tableFromColumns(optionsArg(columns) as Record<string, unknown[]>));
}

function installQuantBuiltins(map: BuiltinMap): void {
  const fn = (name: string): NativeFn => quant[name] as NativeFn;
  register(map, "momentum", (...args) => {
    const { options } = splitOptions(args);
    return fn("momentum")(Number(options.lookback ?? args[0] ?? 20));
  });
  register(map, "mean_reversion", (...args) => {
    const { options } = splitOptions(args);
    return fn("meanReversion")(Number(options.lookback ?? args[0] ?? 20));
  });
  register(map, "zscore", (...args) => {
    const { options } = splitOptions(args);
    return fn("zscore")(Number(options.window ?? args[0] ?? 20));
  });
  register(map, "equal_weight", () => fn("equalWeight")());
  register(map, "cross_sectional", () => fn("crossSectional")());
  register(map, "long_short", (...args) => {
    const { options } = splitOptions(args);
    return fn("longShortRank")(Number(options.fraction ?? args[0] ?? 0.5));
  });
  register(map, "backtest", (prices, ...args) => {
    const { options } = splitOptions(args);
    const signal = quantFunction(options.signal, "momentum", Number(options.lookback ?? 20));
    const portfolio = quantFunction(options.portfolio, "longShortRank", Number(options.fraction ?? 0.5));
    return fn("backtest")(priceMatrix(prices), { signal, portfolio }, camelOptions(options));
  });
  register(map, "walk_forward", (prices, ...args) => {
    const { options } = splitOptions(args);
    return fn("walkForward")(priceMatrix(prices), camelOptions(options));
  });
  register(map, "sharpe", (returns) => fn("sharpe")(returns));
  register(map, "risk_parity", (cov) => fn("riskParity")(cov));
  register(map, "hrp", (cov) => fn("hierarchicalRiskParity")(cov));
  register(map, "mean_variance", (mu, cov) => fn("meanVariance")(mu, cov));
}

function installChartBuiltins(map: BuiltinMap): void {
  const chart: Record<string, RuntimeFunctionPayload> = {};
  for (const type of ["line", "bar", "scatter", "histogram", "area", "box", "violin", "density", "correlation", "hexbin", "heatmap", "regression", "ecdf", "bubble", "funnel", "waterfall"]) {
    chart[type] = hostBuiltin(type, (data: unknown, ...args: unknown[]) => createChartSpec(type, data, splitOptions(args).options), CHART_METADATA[type]);
  }
  (map as Record<string, unknown>).chart = chart;
}

export function createDomainBuiltins(): BuiltinMap {
  const map: BuiltinMap = { ...createModelBuiltins() };
  installTensorBuiltins(map);
  installDataFrameBuiltins(map);
  installQuantBuiltins(map);
  installChartBuiltins(map);
  register(map, "range", (...args) => {
    const start = args.length === 1 ? 0 : Number(args[0] ?? 0);
    const stop = Number(args.length === 1 ? args[0] : args[1]);
    const step = Number(args[2] ?? 1);
    if (step === 0) throw new Error("range() step cannot be zero");
    const out: number[] = [];
    if (step > 0) for (let value = start; value < stop; value += step) out.push(value);
    else for (let value = start; value > stop; value += step) out.push(value);
    return out;
  });
  return map;
}
