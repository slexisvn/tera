import type { ChartPoint, TabularRow } from "./types.js";

type BoxSummary = {
  q1: number;
  median: number;
  q3: number;
  low: number;
  high: number;
  outliers: number[];
};

type DensityPoint = {
  x: number;
  y: number;
};

type RegressionResult = {
  slope: number;
  intercept: number;
  r2: number;
  points: ChartPoint[];
};

type NumericPoint = ChartPoint & {
  x: number;
  y: number;
};

type CorrelationCell = {
  x: string;
  y: string;
  value: number;
  count: number;
};

export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

export function boxSummary(values: number[], whisker = 1.5): BoxSummary | null {
  if (!Number.isFinite(whisker) || whisker <= 0) throw new Error('whisker must be a positive number');
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - whisker * iqr;
  const highFence = q3 + whisker * iqr;
  const inside = sorted.filter(value => value >= lowFence && value <= highFence);
  return {
    q1,
    median,
    q3,
    low: inside[0],
    high: inside[inside.length - 1],
    outliers: sorted.filter(value => value < lowFence || value > highFence),
  };
}

export function silvermanBandwidth(values: number[]): number {
  if (values.length < 2) return 1;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const std = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const sigma = Math.min(std || Infinity, iqr / 1.34 || Infinity);
  const bandwidth = 0.9 * (Number.isFinite(sigma) ? sigma : std || 1) * values.length ** -0.2;
  return bandwidth > 0 ? bandwidth : 1;
}

export function kde(values: number[], bandwidth: number | null = null, resolution = 80): { bandwidth: number; points: DensityPoint[] } {
  if (!values.length) return { bandwidth: bandwidth ?? 1, points: [] };
  const bw = bandwidth == null ? silvermanBandwidth(values) : Number(bandwidth);
  if (!Number.isFinite(bw) || bw <= 0) throw new Error('bandwidth must be a positive number');
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= bw * 2;
    max += bw * 2;
  } else {
    min -= bw * 3;
    max += bw * 3;
  }
  const norm = values.length * bw * Math.sqrt(2 * Math.PI);
  const points: DensityPoint[] = [];
  for (let index = 0; index < resolution; index++) {
    const x = min + (max - min) * index / (resolution - 1);
    const density = values.reduce((sum, value) => sum + Math.exp(-0.5 * ((x - value) / bw) ** 2), 0) / norm;
    points.push({ x, y: density });
  }
  return { bandwidth: bw, points };
}

export function pearson(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 2) return NaN;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftSum = 0;
  let rightSum = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftSum += a * a;
    rightSum += b * b;
  }
  const denominator = Math.sqrt(leftSum * rightSum);
  return denominator === 0 ? NaN : numerator / denominator;
}

export function linearRegression(points: ChartPoint[]): RegressionResult | null {
  const valid = points.filter((point): point is NumericPoint => validNumber(point.x) && validNumber(point.y));
  if (valid.length < 2) return null;
  const meanX = valid.reduce((sum, point) => sum + point.x, 0) / valid.length;
  const meanY = valid.reduce((sum, point) => sum + point.y, 0) / valid.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of valid) {
    const dx = point.x - meanX;
    numerator += dx * (point.y - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) return null;
  const slope = numerator / denominator;
  const intercept = meanY - slope * meanX;
  const minX = Math.min(...valid.map(point => point.x));
  const maxX = Math.max(...valid.map(point => point.x));
  const predict = (x: number) => slope * x + intercept;
  const ssTot = valid.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  const ssRes = valid.reduce((sum, point) => sum + (point.y - predict(point.x)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return {
    slope,
    intercept,
    r2,
    points: [
      { x: minX, y: predict(minX), tooltip: `fit: y = ${formatNumber(slope)}x + ${formatNumber(intercept)}  R²=${formatNumber(r2)}` },
      { x: maxX, y: predict(maxX), tooltip: `fit: y = ${formatNumber(slope)}x + ${formatNumber(intercept)}  R²=${formatNumber(r2)}` },
    ],
  };
}

export function spearman(left: number[], right: number[]): number {
  return pearson(ranks(left), ranks(right));
}

export function ranks(values: number[]): number[] {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result: number[] = new Array(values.length);
  let cursor = 0;
  while (cursor < ordered.length) {
    let end = cursor + 1;
    while (end < ordered.length && ordered[end].value === ordered[cursor].value) end++;
    const rank = (cursor + end - 1) / 2 + 1;
    for (let index = cursor; index < end; index++) result[ordered[index].index] = rank;
    cursor = end;
  }
  return result;
}

export function correlationMatrix(rows: TabularRow[], columns: string[], method = 'pearson'): CorrelationCell[] {
  const correlate = method === 'pearson' ? pearson : method === 'spearman' ? spearman : null;
  if (!correlate) throw new Error('correlation method must be "pearson" or "spearman"');
  const cells: CorrelationCell[] = [];
  for (const rowName of columns) {
    for (const columnName of columns) {
      const left = [];
      const right = [];
      for (const row of rows) {
        const a = row[rowName];
        const b = row[columnName];
        if (validNumber(a) && validNumber(b)) {
          left.push(a);
          right.push(b);
        }
      }
      const value = rowName === columnName && left.length ? 1 : correlate(left, right);
      cells.push({ x: columnName, y: rowName, value, count: left.length });
    }
  }
  return cells;
}

export function makeHexbins(points: ChartPoint[], bins = 30): ChartPoint[] {
  const count = Number(bins);
  if (!Number.isInteger(count) || count < 5 || count > 100) throw new Error('hexbin bins must be an integer between 5 and 100');
  const valid = points.filter((point): point is NumericPoint => validNumber(point.x) && validNumber(point.y));
  if (!valid.length) return [];
  let minX = Math.min(...valid.map(point => point.x));
  let maxX = Math.max(...valid.map(point => point.x));
  let minY = Math.min(...valid.map(point => point.y));
  let maxY = Math.max(...valid.map(point => point.y));
  if (minX === maxX) { minX -= 0.5; maxX += 0.5; }
  if (minY === maxY) { minY -= 0.5; maxY += 0.5; }
  const dx = (maxX - minX) / count;
  const dy = dx * Math.sqrt(3) / 2;
  const map = new Map<string, { column: number; row: number; count: number }>();
  for (const point of valid) {
    const row = Math.round((point.y - minY) / dy);
    const column = Math.round((point.x - minX) / dx - (row & 1) * 0.5);
    const key = `${column}:${row}`;
    const item = map.get(key) ?? { column, row, count: 0 };
    item.count++;
    map.set(key, item);
  }
  return [...map.values()].map(item => {
    const x = minX + (item.column + (item.row & 1) * 0.5) * dx;
    const y = minY + item.row * dy;
    return { ...item, x, y, x0: x - dx / 2, x1: x + dx / 2, y0: y - dy / 2, y1: y + dy / 2 };
  });
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatNumber(value: number): number {
  return Number(value.toPrecision(4));
}
