import { DEFAULT_FRAME_DURATION_MS, normalizeEasing } from './interpolate';
import { DEFAULT_DURATION_MS, normalizeSpeed } from './player';
import type { ChartOptions, ChartRule, ChartSeries } from './types';

export const CHART_SPEC = 'tera.notebook.chart';
export const MAX_POINTS = 10000;
export const MORPHABLE_TYPES = new Set(['line', 'scatter', 'bubble']);
export const CHART_TYPES = new Set([
  'line', 'bar', 'scatter', 'histogram', 'area',
  'box', 'violin', 'density', 'correlation', 'hexbin',
  'heatmap', 'regression', 'ecdf', 'bubble', 'funnel', 'waterfall',
  'figure',
]);

type ChartFrame = {
  value?: string | number;
  series: ChartSeries[];
};

type FigureLayer = {
  series: ChartSeries[];
};

type FigurePanel = {
  label: string;
  layers: FigureLayer[];
};

type FacetConfig = {
  column?: string;
  cols?: number | null;
};

type PayloadLike = {
  steps?: unknown[];
  cells?: unknown[];
  bins?: unknown[];
};

type RawOptions = Record<string, unknown>;

export function isChartSpec(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const spec = value as { kind?: unknown; type?: unknown; series?: unknown; layers?: unknown; panels?: unknown; payload?: unknown };
  return spec.kind === CHART_SPEC && typeof spec.type === 'string' && CHART_TYPES.has(spec.type) && (Array.isArray(spec.series) || Array.isArray(spec.layers) || Array.isArray(spec.panels) || spec.payload != null);
}

function layersPointCount(layers: FigureLayer[]): number {
  return layers.reduce((sum, layer) => sum + layer.series.reduce((inner, item) => inner + item.points.length, 0), 0);
}

export function createFigureSpec(layers: FigureLayer[], options: RawOptions = {}) {
  const pointCount = layersPointCount(layers);
  if (pointCount > MAX_POINTS) {
    throw new Error(`Chart has ${pointCount} points; maximum is ${MAX_POINTS}. Filter or sample the data before charting.`);
  }
  return { kind: CHART_SPEC, type: 'figure', layers, pointCount, options: normalizeOptions(options) };
}

export function createFacetSpec(panels: FigurePanel[], facet: FacetConfig, options: RawOptions = {}) {
  const pointCount = panels.reduce((sum, panel) => sum + layersPointCount(panel.layers), 0);
  if (pointCount > MAX_POINTS) {
    throw new Error(`Chart has ${pointCount} points; maximum is ${MAX_POINTS}. Filter or sample the data before charting.`);
  }
  return { kind: CHART_SPEC, type: 'figure', panels, facet, pointCount, options: normalizeOptions(options) };
}

export function createPayloadSpec(type: string, family: string, payload: PayloadLike | unknown[], options: RawOptions = {}) {
  if (!CHART_TYPES.has(type)) throw new Error(`Unsupported chart type '${type}'`);
  return { kind: CHART_SPEC, type, family, payload, pointCount: payloadPointCount(payload), options: normalizeOptions(options) };
}

export function createSpec(type: string, series: ChartSeries[], options: RawOptions = {}) {
  if (!CHART_TYPES.has(type)) throw new Error(`Unsupported chart type '${type}'`);
  const pointCount = series.reduce((sum, item) => sum + item.points.length, 0);
  if (pointCount > MAX_POINTS) {
    throw new Error(`Chart has ${pointCount} points; maximum is ${MAX_POINTS}. Filter or sample the data before charting.`);
  }
  return {
    kind: CHART_SPEC,
    type,
    series,
    pointCount,
    options: normalizeOptions(options),
  };
}

export function createMorphSpec(type: string, frames: ChartFrame[], key: string, options: RawOptions = {}) {
  if (!MORPHABLE_TYPES.has(type)) throw new Error(`Chart type '${type}' does not support frame animation`);
  const total = frames.reduce((sum, frame) => sum + frame.series.reduce((inner, series) => inner + series.points.length, 0), 0);
  if (total > MAX_POINTS) {
    throw new Error(`Chart has ${total} points; maximum is ${MAX_POINTS}. Filter or sample the data before charting.`);
  }
  const base = createSpec(type, frames[0]?.series ?? [], options);
  return { ...base, animation: buildMorphAnimation(frames, key, options) };
}

function buildMorphAnimation(frames: ChartFrame[], key: string, options: RawOptions) {
  return {
    mode: 'morph',
    frames,
    key,
    durationMs: finitePositive(options.frame_duration ?? options.frameDuration ?? options.duration, DEFAULT_FRAME_DURATION_MS) ?? DEFAULT_FRAME_DURATION_MS,
    easing: normalizeEasing(options.easing),
    loop: options.loop !== false,
    speed: normalizeSpeed(Number(options.speed)),
    autoplay: options.autoplay === true,
  };
}

function buildRevealAnimation(options: RawOptions) {
  return {
    durationMs: finitePositive(options.duration, DEFAULT_DURATION_MS) ?? DEFAULT_DURATION_MS,
    easing: normalizeEasing(options.easing),
    loop: options.loop === true,
    speed: normalizeSpeed(Number(options.speed)),
    autoplay: options.autoplay === true,
  };
}

const REFERENCE_COLOR = '#e06c75';
const DEFAULT_RULE_WIDTH = 1.5;

function normalizeOptions(options: RawOptions): ChartOptions {
  const width = finitePositive(options.width, null);
  const height = finitePositive(options.height, null);
  return {
    title: textOrNull(options.title),
    xLabel: textOrNull(options.x_label ?? options.xLabel),
    yLabel: textOrNull(options.y_label ?? options.yLabel),
    y2Label: textOrNull(options.y2_label ?? options.y2Label),
    width,
    height,
    legend: options.legend !== false,
    zoom: options.zoom !== false,
    mode: typeof options.mode === 'string' ? options.mode : null,
    dash: options.dash === true,
    animate: options.animate === true,
    anim: buildRevealAnimation(options),
    hlines: buildRules(options.hline, options.hline_label ?? options.hlineLabel, options.hline_color ?? options.hlineColor, options.hline_dash ?? options.hlineDash),
    vlines: buildRules(options.vline, options.vline_label ?? options.vlineLabel, options.vline_color ?? options.vlineColor, options.vline_dash ?? options.vlineDash),
  };
}

function buildRules(values: unknown, labels: unknown, colors: unknown, dash: unknown): ChartRule[] {
  if (values == null) return [];
  const valueList = Array.isArray(values) ? values : [values];
  const labelList = Array.isArray(labels) ? labels : [labels];
  const colorList = Array.isArray(colors) ? colors : [colors];
  const dashed = dash !== false;
  const rules: ChartRule[] = [];
  for (let i = 0; i < valueList.length; i += 1) {
    const value = Number(valueList[i]);
    if (!Number.isFinite(value)) continue;
    rules.push({
      value,
      label: labelList[i] != null ? String(labelList[i]) : null,
      color: colorList[i] != null ? String(colorList[i]) : REFERENCE_COLOR,
      dash: dashed,
      width: DEFAULT_RULE_WIDTH,
    });
  }
  return rules;
}

function payloadPointCount(payload: PayloadLike | unknown[]): number {
  if (Array.isArray(payload)) return payload.length;
  if (Array.isArray(payload?.steps)) return payload.steps.length;
  if (Array.isArray(payload?.cells)) return payload.cells.length;
  if (Array.isArray(payload?.bins)) return payload.bins.length;
  return 0;
}

function finitePositive(value: unknown, fallback: number | null): number | null {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('Chart width and height must be positive numbers');
  return number;
}

function textOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}
