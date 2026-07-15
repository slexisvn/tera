import { adaptHistogram, adaptSeries } from './adapters.js';
import { adaptBubble, adaptCorrelation, adaptDensity, adaptDistribution, adaptEcdf, adaptFunnel, adaptHeatmap, adaptHexbin, adaptRegression, adaptWaterfall, prepareSeriesMode } from './advanced_adapters.js';
import { createFigure } from './figure.js';
import { adaptFrames } from './frames.js';
import { createMorphSpec, createPayloadSpec, createSpec, MORPHABLE_TYPES } from './spec.js';

export function createChartApi() {
  return Object.freeze({
    line: (...args) => createSeriesChart('line', args),
    bar: (...args) => createSeriesChart('bar', args),
    scatter: (...args) => createSeriesChart('scatter', args),
    histogram: (...args) => createHistogram(args),
    area: (...args) => createSeriesChart('area', args),
    box: (...args) => createDistribution('box', args),
    violin: (...args) => createDistribution('violin', args),
    density: (...args) => createDensity(args),
    correlation: (...args) => createCorrelation(args),
    hexbin: (...args) => createHexbin(args),
    heatmap: (...args) => createHeatmap(args),
    regression: (...args) => createRegression(args),
    ecdf: (...args) => createEcdf(args),
    bubble: (...args) => createBubble(args),
    funnel: (...args) => createFunnel(args),
    waterfall: (...args) => createWaterfall(args),
    figure: (...args) => createFigureBuilder(args),
  });
}

function createFigureBuilder(args) {
  const { data, options } = splitArgs(args);
  return createFigure(data, options);
}

async function createSeriesChart(type, args) {
  const { data, options } = splitArgs(args);
  if (options.frame != null && MORPHABLE_TYPES.has(type)) return createMorphChart(type, data, options);
  const raw = await adaptSeries(data, options);
  const prepared = type === 'bar' || type === 'area' ? prepareSeriesMode(raw, type, options.mode) : { mode: null, series: raw };
  return createSpec(type, prepared.series, { ...options, mode: prepared.mode });
}

async function createMorphChart(type, data, options) {
  const { frames, key } = await adaptFrames(type, data, options);
  if (frames.length < 2) return createSpec(type, frames[0]?.series ?? [], options);
  return createMorphSpec(type, frames, key, options);
}

async function createDistribution(type, args) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec(type, 'distribution', await adaptDistribution(data, options, type === 'violin'), options);
}

async function createDensity(args) {
  const { data, options } = splitArgs(args);
  return createSpec('density', await adaptDensity(data, options), options);
}

async function createCorrelation(args) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec('correlation', 'matrix', await adaptCorrelation(data, options), options);
}

async function createHexbin(args) {
  const { data, options } = splitArgs(args);
  const payload = await adaptHexbin(data, options);
  return createSpec('hexbin', [{ name: 'count', points: payload.bins.map(bin => ({ ...bin, value: bin.count })) }], options);
}

async function createHeatmap(args) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec('heatmap', 'matrix', await adaptHeatmap(data, options), options);
}

async function createRegression(args) {
  const { data, options } = splitArgs(args);
  const payload = await adaptRegression(data, options);
  return createSpec('regression', payload.series, { ...options, zoom: options.zoom ?? true });
}

async function createEcdf(args) {
  const { data, options } = splitArgs(args);
  return createSpec('ecdf', await adaptEcdf(data, options), { ...options, y_label: options.y_label ?? options.yLabel ?? 'Cumulative probability' });
}

async function createBubble(args) {
  const { data, options } = splitArgs(args);
  if (options.frame != null) return createMorphChart('bubble', data, options);
  return createSpec('bubble', await adaptBubble(data, options), options);
}

async function createFunnel(args) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec('funnel', 'funnel', await adaptFunnel(data, options), options);
}

async function createWaterfall(args) {
  const { data, options } = splitArgs(args);
  return createPayloadSpec('waterfall', 'waterfall', await adaptWaterfall(data, options), options);
}

async function createHistogram(args) {
  const { data, options } = splitArgs(args);
  const series = await adaptHistogram(data, options);
  return createSpec('histogram', series, options);
}

function splitArgs(args) {
  const values = [...args];
  const named = values.at(-1)?.__named ? values.pop() : {};
  if (values.length !== 1) throw new Error('chart functions expect one data argument followed by named options');
  const options = { ...named };
  delete options.__named;
  return { data: values[0], options };
}
