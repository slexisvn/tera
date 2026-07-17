import { adaptHistogram, adaptSeries } from './adapters';
import { adaptBubble, adaptCorrelation, adaptDensity, adaptDistribution, adaptEcdf, adaptFunnel, adaptHeatmap, adaptHexbin, adaptRegression, adaptWaterfall, prepareSeriesMode } from './advanced_adapters';
import { createFigure } from './figure';
import { adaptFrames } from './frames';
import { createMorphSpec, createPayloadSpec, createSpec, MORPHABLE_TYPES } from './spec';
import type { ChartConfig } from './types';

type ChartArgs = unknown[];

type SplitArgs = {
  data: unknown;
  options: ChartConfig;
};

type NamedArgs = ChartConfig & {
  __named?: boolean;
};

export function createChartApi() {
  return Object.freeze({
    line: (...args: ChartArgs) => createSeriesChart('line', args),
    bar: (...args: ChartArgs) => createSeriesChart('bar', args),
    scatter: (...args: ChartArgs) => createSeriesChart('scatter', args),
    histogram: (...args: ChartArgs) => createHistogram(args),
    area: (...args: ChartArgs) => createSeriesChart('area', args),
    box: (...args: ChartArgs) => createDistribution('box', args),
    violin: (...args: ChartArgs) => createDistribution('violin', args),
    density: (...args: ChartArgs) => createDensity(args),
    correlation: (...args: ChartArgs) => createCorrelation(args),
    hexbin: (...args: ChartArgs) => createHexbin(args),
    heatmap: (...args: ChartArgs) => createHeatmap(args),
    regression: (...args: ChartArgs) => createRegression(args),
    ecdf: (...args: ChartArgs) => createEcdf(args),
    bubble: (...args: ChartArgs) => createBubble(args),
    funnel: (...args: ChartArgs) => createFunnel(args),
    waterfall: (...args: ChartArgs) => createWaterfall(args),
    figure: (...args: ChartArgs) => createFigureBuilder(args),
  });
}

function createFigureBuilder(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  return createFigure(data, options);
}

async function createSeriesChart(type: string, args: ChartArgs) {
  const { data, options } = splitArgs(args);
  if (options.frame != null && MORPHABLE_TYPES.has(type)) return createMorphChart(type, data, options);
  const raw = await adaptSeries(data, options);
  const prepared = type === 'bar' || type === 'area' ? prepareSeriesMode(raw, type, options.mode) : { mode: null, series: raw };
  return createSpec(type, prepared.series, { ...options, mode: prepared.mode });
}

async function createMorphChart(type: string, data: unknown, options: ChartConfig) {
  const { frames, key } = await adaptFrames(type, data, options);
  if (frames.length < 2) return createSpec(type, frames[0]?.series ?? [], options);
  return createMorphSpec(type, frames, key, options);
}

async function createDistribution(type: string, args: ChartArgs) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec(type, 'distribution', await adaptDistribution(data, options, type === 'violin'), options);
}

async function createDensity(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  return createSpec('density', await adaptDensity(data, options), options);
}

async function createCorrelation(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec('correlation', 'matrix', await adaptCorrelation(data, options), options);
}

async function createHexbin(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  const payload = await adaptHexbin(data, options);
  return createSpec('hexbin', [{ name: 'count', points: payload.bins.map(bin => ({ ...bin, value: bin.count })) }], options);
}

async function createHeatmap(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec('heatmap', 'matrix', await adaptHeatmap(data, options), options);
}

async function createRegression(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  const payload = await adaptRegression(data, options);
  return createSpec('regression', payload.series, { ...options, zoom: options.zoom ?? true });
}

async function createEcdf(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  return createSpec('ecdf', await adaptEcdf(data, options), { ...options, y_label: options.y_label ?? options.yLabel ?? 'Cumulative probability' });
}

async function createBubble(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  if (options.frame != null) return createMorphChart('bubble', data, options);
  return createSpec('bubble', await adaptBubble(data, options), options);
}

async function createFunnel(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec('funnel', 'funnel', await adaptFunnel(data, options), options);
}

async function createWaterfall(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec('waterfall', 'waterfall', await adaptWaterfall(data, options), options);
}

async function createHistogram(args: ChartArgs) {
  const { data, options } = splitArgs(args);
  const series = await adaptHistogram(data, options);
  return createSpec('histogram', series, options);
}

function splitArgs(args: ChartArgs): SplitArgs {
  const values = [...args];
  const last = values.at(-1);
  const named = isNamedArgs(last) ? values.pop() as NamedArgs : {};
  if (values.length !== 1) throw new Error('chart functions expect one data argument followed by named options');
  const options = { ...named };
  delete options.__named;
  return { data: values[0], options };
}

function isNamedArgs(value: unknown): value is NamedArgs {
  return Boolean(value && typeof value === 'object' && (value as { __named?: unknown }).__named);
}
