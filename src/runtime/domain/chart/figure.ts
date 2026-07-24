import { splitOptions } from "../common.js";
import { adaptHistogram, adaptSeries, isDataFrame } from "./adapters.js";
import { adaptBubble, adaptRegression, prepareSeriesMode } from "./advanced_adapters.js";
import { CHART_SPEC, createFacetSpec, createFigureSpec } from "./spec.js";
import type { ChartConfig, ChartSeries, DataFrameLike, TabularRow } from "./types.js";

const MARKS = ['line', 'bar', 'scatter', 'area', 'histogram', 'regression', 'bubble'];
const MARK_ALIAS: Record<string, string> = { point: 'scatter' };
const ENCODE_COLUMN_KEYS = ['x', 'y', 'color', 'size', 'value'];

type FigureOptions = {
  title?: string;
  [key: string]: unknown;
};

type FigureDescriptor = {
  mark: string;
  encode: ChartConfig;
};

type FacetConfig = ChartConfig & {
  field?: string;
  col?: string;
  row?: string;
  cols?: unknown;
  columns?: unknown;
};

type FigureLayer = {
  mark: string;
  axis: 'left' | 'right';
  mode: string | null;
  series: ChartSeries[];
};

type FigureBuilder = {
  kind: string;
  type: string;
  __isFigureBuilder: boolean;
  encode(...args: unknown[]): FigureBuilder;
  facet(...args: unknown[]): FigureBuilder;
  title(value: unknown): FigureBuilder;
  build(): Promise<unknown>;
  [key: string]: unknown;
};

export function createFigure(data: unknown, options: FigureOptions = {}): FigureBuilder {
  const encode: ChartConfig = {};
  const descriptors: FigureDescriptor[] = [];
  let facetConfig: FacetConfig | null = null;
  const builder: FigureBuilder = {
    kind: CHART_SPEC,
    type: 'figure',
    __isFigureBuilder: true,
    encode: (...args: unknown[]) => {
      Object.assign(encode, takeNamed(args));
      return builder;
    },
    facet: (...args: unknown[]) => {
      const { values, options: named } = splitOptions(args);
      facetConfig = { ...(facetConfig ?? {}) };
      if (typeof values[0] === 'string') facetConfig.field = values[0];
      Object.assign(facetConfig, named);
      return builder;
    },
    title: (value: unknown) => {
      options.title = value == null ? undefined : String(value);
      return builder;
    },
    build: () => buildFigure(data, descriptors, options, facetConfig),
  };
  for (const name of [...MARKS, ...Object.keys(MARK_ALIAS)]) {
    builder[name] = (...args: unknown[]) => {
      descriptors.push({ mark: MARK_ALIAS[name] ?? name, encode: { ...encode, ...takeNamed(args) } });
      return builder;
    };
  }
  return builder;
}

async function buildFigure(data: unknown, descriptors: FigureDescriptor[], options: FigureOptions, facetConfig: FacetConfig | null) {
  if (data == null) throw new Error('chart.figure() requires data as the first argument');
  if (descriptors.length === 0) throw new Error('chart.figure() needs at least one mark, e.g. .line(y="...")');
  if (facetConfig) return buildFaceted(data, descriptors, options, facetConfig);
  const layers: FigureLayer[] = [];
  for (const descriptor of descriptors) layers.push(await buildLayer(data, descriptor.mark, descriptor.encode));
  return createFigureSpec(layers, options);
}

async function buildFaceted(data: unknown, descriptors: FigureDescriptor[], options: FigureOptions, facetConfig: FacetConfig) {
  const field = facetConfig.field ?? facetConfig.col ?? facetConfig.row;
  if (typeof field !== 'string' || field.length === 0) throw new Error('chart.figure().facet() requires a column, e.g. .facet("region") or .facet(col="region")');
  if (!isDataFrame(data)) throw new Error('chart.figure().facet() requires a DataFrame');
  const cols = unique([field, ...referencedColumns(descriptors)]);
  const rows = await data.select(...cols).collect();
  const groups = new Map<string, TabularRow[]>();
  for (const row of rows) {
    const key = row[field] == null ? 'NULL' : String(row[field]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(row);
  }
  if (groups.size === 0) throw new Error(`chart.figure().facet() found no rows for column '${field}'`);
  const panels: Array<{ label: string; layers: FigureLayer[] }> = [];
  for (const [label, groupRows] of groups) {
    const frame = frameFromRows(groupRows);
    const layers: FigureLayer[] = [];
    for (const descriptor of descriptors) layers.push(await buildLayer(frame, descriptor.mark, descriptor.encode));
    panels.push({ label, layers });
  }
  const cols2 = positiveIntOrNull(facetConfig.cols ?? facetConfig.columns);
  return createFacetSpec(panels, { column: field, cols: cols2 }, options);
}

async function buildLayer(data: unknown, mark: string, encode: ChartConfig): Promise<FigureLayer> {
  const axis = encode.axis === 'right' ? 'right' : 'left';
  let series: ChartSeries[];
  let mode: string | null = null;
  if (mark === 'histogram') {
    series = await adaptHistogram(data, encode);
  } else if (mark === 'regression') {
    series = (await adaptRegression(data, encode)).series;
  } else if (mark === 'bubble') {
    series = await adaptBubble(data, encode);
  } else {
    const raw = await adaptSeries(data, encode);
    if (mark === 'bar' || mark === 'area') {
      const prepared = prepareSeriesMode(raw, mark, encode.mode);
      series = prepared.series;
      mode = prepared.mode;
    } else {
      series = raw;
    }
  }
  if (mode === 'stacked') series = stackSeries(series);
  return { mark, axis, mode, series };
}

function stackSeries(series: ChartSeries[]): ChartSeries[] {
  const positive = new Map<string, number>();
  const negative = new Map<string, number>();
  return series.map(item => ({
    ...item,
    points: item.points.map(point => {
      const key = String(point.x);
      const map = point.y >= 0 ? positive : negative;
      const y0 = map.get(key) ?? 0;
      const y1 = y0 + point.y;
      map.set(key, y1);
      return { ...point, y0, y1 };
    }),
  }));
}

function frameFromRows(rows: TabularRow[]): DataFrameLike {
  return {
    select: (...cols: string[]) => frameFromRows(rows.map(row => {
      const picked: TabularRow = {};
      for (const col of cols) picked[col] = row[col];
      return picked;
    })),
    collect: async () => rows,
    count: async () => rows.length,
    columns: async () => Object.keys(rows[0] ?? {}),
  };
}

function referencedColumns(descriptors: FigureDescriptor[]): string[] {
  const cols = new Set<string>();
  for (const descriptor of descriptors) {
    for (const key of ENCODE_COLUMN_KEYS) {
      const value = descriptor.encode[key];
      if (typeof value === 'string') cols.add(value);
      else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') cols.add(item);
    }
  }
  return [...cols];
}

function positiveIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error('chart.figure().facet() cols must be a positive integer');
  return number;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function takeNamed(args: unknown[]): ChartConfig {
  return splitOptions(args).options;
}
