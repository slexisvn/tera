import { MAX_POINTS } from './spec';
import type { ChartConfig, ChartDimension, ChartPoint, ChartSeries, DataFrameLike, TabularRow, TensorLike } from './types';

type HistogramGroup = {
  name: string;
  values: number[];
};

export function isDataFrame(value: unknown): value is DataFrameLike {
  return Boolean(value && typeof value === 'object' && 'select' in value && typeof value.select === 'function' && 'collect' in value && typeof value.collect === 'function' && 'count' in value && typeof value.count === 'function');
}

export function isTensor(value: unknown): value is TensorLike {
  return Boolean(value && typeof value === 'object' && 'shape' in value && Array.isArray(value.shape) && 'toArray' in value && typeof value.toArray === 'function');
}

export async function adaptSeries(data: unknown, config: ChartConfig): Promise<ChartSeries[]> {
  if (isDataFrame(data)) return adaptDataFrame(data, config);
  if (isTensor(data)) return adaptArray(data.toArray(), config);
  if (Array.isArray(data)) return adaptArray(data, config);
  throw new Error('chart data must be a DataFrame, Tensor, or array');
}

export async function adaptHistogram(data: unknown, config: ChartConfig): Promise<ChartSeries[]> {
  let groups: HistogramGroup[];
  if (isDataFrame(data)) {
    const x = requiredColumn(config.x, 'x');
    groups = await dataFrameGroups(data, x, typeof config.color === 'string' ? config.color : null);
  } else {
    const values = isTensor(data) ? data.toArray() : data;
    if (!Array.isArray(values)) throw new Error('histogram data must be a DataFrame, Tensor, or array');
    groups = [{ name: 'value', values: flattenNumeric(values, 'histogram data') }];
  }
  return groups.map(group => ({
    name: group.name,
    points: histogramPoints(group.values, config.bins),
  }));
}

async function adaptDataFrame(data: DataFrameLike, config: ChartConfig): Promise<ChartSeries[]> {
  const x = requiredColumn(config.x, 'x');
  const ys = normalizeSelections(config.y, 'y');
  if (ys.length === 0) throw new Error('DataFrame charts require y="column" or y=["column1", "column2"]');
  const rowCount = Number(await data.count());
  ensurePointLimit(rowCount * ys.length);
  const columns = unique([x, ...ys, typeof config.color === 'string' ? config.color : null].filter((value): value is string => value != null));
  const rows = await data.select(...columns).collect();
  const grouped = groupRows(rows, typeof config.color === 'string' ? config.color : null);
  const series: ChartSeries[] = [];
  for (const [groupName, groupRowsValue] of grouped) {
    for (const y of ys) {
      const name = config.color == null ? String(y) : `${y} · ${groupName}`;
      const points: ChartPoint[] = [];
      for (const row of groupRowsValue) {
        const yValue = numericOrSkip(row[y], `Column '${y}'`);
        if (yValue == null) continue;
        const xValue = dimensionOrSkip(row[x]);
        if (xValue == null) continue;
        points.push({ x: xValue, y: yValue });
      }
      series.push({ name, points });
    }
  }
  return series;
}

function adaptArray(data: unknown[], config: ChartConfig): ChartSeries[] {
  if (data.length === 0) return [{ name: 'value', points: [] }];
  if (!Array.isArray(data[0])) {
    const values = data;
    ensurePointLimit(values.length);
    const points: ChartPoint[] = [];
    for (let i = 0; i < values.length; i++) {
      const y = numericOrSkip(values[i], 'Array value');
      if (y != null) points.push({ x: i, y });
    }
    return [{ name: 'value', points }];
  }
  const width = data[0].length;
  const ys = normalizeIndexSelections(config.y, width);
  ensurePointLimit(data.length * ys.length);
  const xIndex = config.x == null ? null : numericIndex(config.x, width, 'x');
  return ys.map((yIndex): ChartSeries => {
    const points: ChartPoint[] = [];
    for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
      const row = data[rowIndex];
      if (!Array.isArray(row) || row.length !== width) throw new Error('Chart array rows must have equal length');
      const y = numericOrSkip(row[yIndex], `Column ${yIndex}`);
      const x = xIndex == null ? rowIndex : dimensionOrSkip(row[xIndex]);
      if (x != null && y != null) points.push({ x, y });
    }
    return { name: `column ${yIndex}`, points };
  });
}

async function dataFrameGroups(data: DataFrameLike, x: string, color: string | null): Promise<HistogramGroup[]> {
  const rowCount = Number(await data.count());
  ensurePointLimit(rowCount);
  const columns = unique([x, color].filter(value => value != null));
  const rows = await data.select(...columns).collect();
  const grouped = groupRows(rows, color);
  const result: HistogramGroup[] = [];
  for (const [name, values] of grouped) {
    const numeric: number[] = [];
    for (const row of values) {
      const value = numericOrSkip(row[x], `Column '${x}'`);
      if (value != null) numeric.push(value);
    }
    result.push({ name: color == null ? String(x) : name, values: numeric });
  }
  return result;
}

function histogramPoints(values: number[], binsValue: unknown): ChartPoint[] {
  const bins = binsValue == null ? 20 : Number(binsValue);
  if (!Number.isInteger(bins) || bins < 1 || bins > 200) throw new Error('histogram bins must be an integer between 1 and 200');
  if (values.length === 0) return [];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  const step = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const value of values) counts[Math.min(bins - 1, Math.floor((value - min) / step))]++;
  return counts.map((count, index) => {
    const x0 = min + index * step;
    const x1 = x0 + step;
    return { x: (x0 + x1) / 2, y: count, x0, x1 };
  });
}

function groupRows(rows: TabularRow[], color: string | null): Map<string, TabularRow[]> {
  if (color == null) return new Map([['value', rows]]);
  const groups = new Map<string, TabularRow[]>();
  for (const row of rows) {
    const key = row[color] == null ? 'NULL' : String(row[color]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(row);
  }
  return groups;
}

function flattenNumeric(values: unknown, label: string): number[] {
  const result: number[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const number = numericOrSkip(value, label);
    if (number != null) result.push(number);
  };
  visit(values);
  ensurePointLimit(result.length);
  return result;
}

function numericOrSkip(value: unknown, label: string): number | null {
  if (value == null || (typeof value === 'number' && Number.isNaN(value))) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} contains non-numeric value '${value}'`);
  return value;
}

function dimensionOrSkip(value: unknown): ChartDimension | null {
  if (value == null || (typeof value === 'number' && Number.isNaN(value))) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return typeof value === 'string' || typeof value === 'number' ? value : String(value);
}

function normalizeSelections(value: unknown, label: string): string[] {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== 'string') throw new Error(`${label} must be a column name or array of column names`);
  }
  return values;
}

function normalizeIndexSelections(value: unknown, width: number): number[] {
  if (value == null) return Array.from({ length: width }, (_, index) => index);
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => numericIndex(item, width, 'y'));
}

function numericIndex(value: unknown, width: number, label: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= width) throw new Error(`${label} column index must be between 0 and ${width - 1}`);
  return index;
}

function requiredColumn(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`DataFrame charts require ${label}="column"`);
  return value;
}

function ensurePointLimit(count: number): void {
  if (count > MAX_POINTS) throw new Error(`Chart has ${count} points; maximum is ${MAX_POINTS}. Filter or sample the data before charting.`);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
