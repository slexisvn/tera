import { adaptHistogram, adaptSeries } from "./adapters.js";
import { adaptBubble, adaptCorrelation, adaptDensity, adaptDistribution, adaptEcdf, adaptFunnel, adaptHeatmap, adaptHexbin, adaptRegression, adaptWaterfall, prepareSeriesMode } from "./advanced_adapters.js";
import { createFigure } from "./figure.js";
import { adaptFrames } from "./frames.js";
import { createMorphSpec, createPayloadSpec, createSpec, MORPHABLE_TYPES, type ChartPayload } from "./spec.js";
import type { ChartConfig, ChartSeries } from "./types.js";

const STACKABLE = new Set(['bar', 'area']);

type ChartBuilder = (data: unknown, options: ChartConfig) => unknown;
type SeriesAdapter = (data: unknown, options: ChartConfig) => Promise<ChartSeries[]>;
type PayloadAdapter = (data: unknown, options: ChartConfig) => Promise<ChartPayload>;

async function morphChart(type: string, data: unknown, options: ChartConfig) {
  const { frames, key } = await adaptFrames(type, data, options);
  if (frames.length < 2) return createSpec(type, frames[0]?.series ?? [], options);
  return createMorphSpec(type, frames, key, options);
}

function seriesChart(type: string, adapt: SeriesAdapter = adaptSeries, extra: (options: ChartConfig) => ChartConfig = () => ({})): ChartBuilder {
  return async (data, options) => {
    if (options.frame != null && MORPHABLE_TYPES.has(type)) return morphChart(type, data, options);
    const raw = await adapt(data, options);
    const prepared = STACKABLE.has(type) ? prepareSeriesMode(raw, type, options.mode) : { mode: null, series: raw };
    return createSpec(type, prepared.series, { ...options, ...extra(options), mode: prepared.mode });
  };
}

function payloadChart(type: string, family: string, adapt: PayloadAdapter): ChartBuilder {
  return async (data, options) => createPayloadSpec(type, family, await adapt(data, options), options);
}

const BUILDERS: Record<string, ChartBuilder> = {
  line: seriesChart('line'),
  bar: seriesChart('bar'),
  scatter: seriesChart('scatter'),
  area: seriesChart('area'),
  bubble: seriesChart('bubble', adaptBubble),
  histogram: seriesChart('histogram', adaptHistogram),
  density: seriesChart('density', adaptDensity),
  ecdf: seriesChart('ecdf', adaptEcdf, options => ({ y_label: options.y_label ?? options.yLabel ?? 'Cumulative probability' })),
  regression: seriesChart('regression', async (data, options) => (await adaptRegression(data, options)).series, options => ({ zoom: options.zoom ?? true })),
  hexbin: seriesChart('hexbin', async (data, options) => {
    const { bins } = await adaptHexbin(data, options);
    return [{ name: 'count', points: bins.map(bin => ({ ...bin, value: bin.count })) }];
  }),
  box: payloadChart('box', 'distribution', (data, options) => adaptDistribution(data, options, false)),
  violin: payloadChart('violin', 'distribution', (data, options) => adaptDistribution(data, options, true)),
  correlation: payloadChart('correlation', 'matrix', adaptCorrelation),
  heatmap: payloadChart('heatmap', 'matrix', adaptHeatmap),
  funnel: payloadChart('funnel', 'funnel', adaptFunnel),
  waterfall: payloadChart('waterfall', 'waterfall', adaptWaterfall),
  figure: (data, options) => createFigure(data, options),
};

export function createChartSpec(type: string, data: unknown, options: ChartConfig): unknown {
  const build = BUILDERS[type];
  if (!build) throw new Error(`Unsupported chart type '${type}'`);
  return build(data, options);
}
