import type { RuntimeFunctionMetadata, RuntimeFunctionPayload } from "../../core/value/index.js";
import { hostBuiltin } from "./host.js";
import { splitOptions } from "./common.js";

type BuiltinMap = Record<string, RuntimeFunctionPayload>;

function numeric(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} contains non-numeric value '${String(value)}'`);
  return number;
}

function tensorArray(data: unknown): unknown {
  if (data && typeof data === "object" && typeof (data as { toArray?: unknown }).toArray === "function") return (data as { toArray(): unknown }).toArray();
  return data;
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
  for (const name of names) if (!columns.includes(name)) throw new Error(`Chart ${label} column '${name}' does not exist`);
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
      if (y !== null) points.push({ x: xName ? row[xName] : rowIndex, y });
    }
    return { name, points };
  });
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

function arraySeries(data: unknown, options: Record<string, unknown>): Array<{ name: string; points: Array<Record<string, unknown>> }> {
  const frameSeries = dataFrameSeries(data, options);
  if (frameSeries) return frameSeries;
  const values = tensorArray(data);
  if (!Array.isArray(values)) return [{ name: String(options.y ?? "value"), points: [] }];
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
      if (y !== null) points.push({ x: xIndex === null ? rowIndex : row[xIndex], y });
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
  return [{ name: "value", points: counts.map((countValue, index) => ({ x: minValue + (index + 0.5) * step, y: countValue, x0: minValue + index * step, x1: minValue + (index + 1) * step })) }];
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

function createChartSpec(type: string, data: unknown, options: Record<string, unknown>): unknown {
  const series = type === "histogram" ? histogramSeries(data, options) : arraySeries(data, options);
  return {
    kind: "tera.notebook.chart",
    type,
    series,
    pointCount: series.reduce((sum, item) => sum + item.points.length, 0),
    options: normalizeChartOptions(options),
  };
}

export function installChartBuiltins(map: BuiltinMap, metadata: Record<string, RuntimeFunctionMetadata>): void {
  const chart: Record<string, RuntimeFunctionPayload> = {};
  for (const type of ["line", "bar", "scatter", "histogram", "area", "box", "violin", "density", "correlation", "hexbin", "heatmap", "regression", "ecdf", "bubble", "funnel", "waterfall"]) {
    chart[type] = hostBuiltin(type, (data: unknown, ...args: unknown[]) => createChartSpec(type, data, splitOptions(args).options), metadata[type]);
  }
  (map as Record<string, unknown>).chart = chart;
}
