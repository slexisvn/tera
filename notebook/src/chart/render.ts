import { renderAxes, renderRightAxis } from './axis';
import { renderLegend } from './legend';
import { renderReferenceLines, labeledRuleExtras } from './rules';
import { createZoomInteraction } from './interaction';
import { colorAt } from '../../../src/runtime/domain/chart/palette';
import { getRenderer, registerRenderer } from './registry';
import { createScale } from './scales';
import { isChartSpec } from '../../../src/runtime/domain/chart/spec';
import { svgElement, svgText } from './svg';
import { createTooltip } from './tooltip';
import { renderBar, renderHistogram } from './renderers/bar';
import { renderLine } from './renderers/line';
import { renderScatter } from './renderers/scatter';
import { renderArea } from './renderers/area';
import { renderHexbin } from './renderers/hexbin';
import { renderRegression } from './renderers/regression';
import { renderBubble } from './renderers/bubble';
import { renderPayloadChart } from './payload_renderers';
import { domainsEqual } from './zoom';
import { shouldAnimate, createAnimationController, revealPoints, prefersReducedMotion, isBrowserAnimation } from './animate';
import { getEasing, indexMarks, segmentAt, tweenLinePath, tweenMark, unionKeys } from './interpolate';
import type { ChartLayout, ChartOptions, ChartPoint, ChartScale, ChartSeries, LinearScale, TooltipApi } from './types';

const ANIMATABLE_TYPES = new Set(['line', 'area', 'scatter']);
const SCATTER_RADIUS = 4;

type ZoomDomains = {
  x: [number, number];
  y: [number, number];
};

type RenderableChartSpec = {
  kind: string;
  type: string;
  series: ChartSeries[];
  options: ChartOptions;
  payload?: unknown;
  family?: string;
  animation?: {
    mode: string;
    frames: ChartFrame[];
    easing: string;
    durationMs: number;
    loop: boolean;
    speed: number;
    autoplay: boolean;
  };
  layers?: FigureLayer[];
  panels?: Array<{ label: string; layers: FigureLayer[] }>;
  facet?: { cols?: number | null };
};

type ChartFrame = {
  value?: string | number;
  series: ChartSeries[];
};

type FigureLayer = {
  mark: string;
  axis: 'left' | 'right';
  mode?: string | null;
  series: ChartSeries[];
};

type FigureItem = {
  mark: string;
  axis: 'left' | 'right';
  mode?: string | null;
  series: ChartSeries;
  color: string;
  index: number;
};

type FigureScales = {
  x: ChartScale;
  y: ChartScale;
  yRight: ChartScale | null;
};

type ZoomContext = {
  enabled: boolean;
  bounds: ZoomDomains;
  domains: ZoomDomains;
  layout: ChartLayout & { width: number; height: number };
  svg: SVGElement;
  x: LinearScale;
  y: LinearScale;
};

registerRenderer('line', renderLine);
registerRenderer('bar', renderBar);
registerRenderer('scatter', renderScatter);
registerRenderer('histogram', renderHistogram);
registerRenderer('area', renderArea);
registerRenderer('density', renderLine);
registerRenderer('ecdf', renderLine);
registerRenderer('hexbin', renderHexbin);
registerRenderer('regression', renderRegression);
registerRenderer('bubble', renderBubble);

export function renderStaticChart(host: HTMLElement, spec: unknown): () => void {
  if (!isChartSpec(spec)) throw new Error('renderStaticChart expects a ChartSpec');
  return renderChart(host, toStaticSpec(spec as RenderableChartSpec));
}

function toStaticSpec(spec: RenderableChartSpec): RenderableChartSpec {
  if (spec.animation?.mode === 'morph') {
    const last = spec.animation.frames.at(-1);
    return { ...spec, animation: undefined, series: last?.series ?? spec.series };
  }
  if (spec.options?.animate) return { ...spec, options: { ...spec.options, animate: false } };
  return spec;
}

function revealFraction(animation: { fraction(): number } | null, anim?: { easing?: string }): number {
  if (!animation) return 1;
  return getEasing(anim?.easing)(animation.fraction());
}

export function renderChart(host: HTMLElement, spec: unknown): () => void {
  if (!isChartSpec(spec)) throw new Error('renderChart expects a ChartSpec');
  const chartSpec = spec as RenderableChartSpec;
  if (chartSpec.type === 'figure') return renderFigure(host, chartSpec);
  if (chartSpec.payload != null) return renderPayloadChart(host, chartSpec as Parameters<typeof renderPayloadChart>[1]);
  if (chartSpec.animation?.mode === 'morph' && isBrowserAnimation()) return renderMorph(host, chartSpec);
  const hidden = new Set<number>();
  const initialSeries = layoutSeries(chartSpec.series, chartSpec);
  const allSpecPoints = initialSeries.flatMap(series => series.points);
  const xValues = allSpecPoints.map(point => point.x);
  const yValues = allSpecPoints.flatMap(point => [point.y, point.y0, point.y1].filter(value => value != null));
  const baseX = createScale(xValues, 0, 1, { padding: chartSpec.type === 'bar' ? 0 : 0.03 });
  const baseY = createScale(yValues, 1, 0, { zero: ['bar', 'histogram', 'area', 'density'].includes(chartSpec.type), padding: 0.08 });
  const zoomEnabled = Boolean(chartSpec.options.zoom && ['line', 'scatter', 'histogram', 'area', 'density', 'hexbin', 'regression', 'ecdf', 'bubble'].includes(chartSpec.type) && baseX.type === 'linear' && baseY.type === 'linear');
  const bounds = zoomEnabled ? { x: numericDomain(baseX), y: numericDomain(baseY) } : null;
  let domains: ZoomDomains | null = bounds ? { x: [bounds.x[0], bounds.x[1]], y: [bounds.y[0], bounds.y[1]] } : null;
  const anim = chartSpec.options.anim;
  const animation = shouldAnimate(Boolean(chartSpec.options.animate), chartSpec.type, ANIMATABLE_TYPES)
    ? createAnimationController(host, { duration: anim?.durationMs, loop: anim?.loop, speed: anim?.speed, autoplay: anim?.autoplay })
    : null;
  const surface = animation ? animation.stage : host;
  let interactionContext: ZoomContext | null = null;
  let observer: ResizeObserver | null = null;
  let tooltip: TooltipApi | null = null;
  let frame = 0;

  const drawSoon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };

  const draw = () => {
    tooltip?.remove();
    surface.innerHTML = '';
    host.className = 'chart-view';
    host.classList.toggle('chart-zoom-enabled', zoomEnabled);
    const width = chartSpec.options.width ?? Math.max(320, host.clientWidth || 720);
    const height = chartHeight(width, chartSpec.options.height);
    const compact = width < 520;
    host.classList.toggle('chart-compact', compact);
    const layout = { width, height, left: compact ? 44 : 58, right: width - 16, top: chartSpec.options.title ? 42 : 20, bottom: height - (compact ? 42 : 48) };
    const selected = chartSpec.series.map((series, index) => ({ ...series, index, color: colorAt(index), dash: chartSpec.options.dash })).filter(series => !hidden.has(series.index ?? -1));
    const visible = layoutSeries(selected, chartSpec);
    const fraction = revealFraction(animation, anim);
    const drawn = animation ? visible.map(series => ({ ...series, points: revealPoints(series.points, fraction, baseX) })) : visible;
    const svg = svgElement('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img' });
    if (chartSpec.options.title) svg.append(svgText(chartSpec.options.title, { class: 'chart-title', x: layout.left, y: 24 }));
    const x = createScale(xValues, layout.left, layout.right, { padding: chartSpec.type === 'bar' ? 0 : 0.03, domain: domains?.x });
    const y = createScale(yValues, layout.bottom, layout.top, { zero: ['bar', 'histogram', 'area', 'density'].includes(chartSpec.type), padding: 0.08, domain: domains?.y });
    renderAxes(svg, layout, x, y, { x: chartSpec.options.xLabel, y: chartSpec.options.yLabel });
    if (chartSpec.options.width != null) svg.style.width = `${width}px`;
    tooltip = createTooltip(host);
    const activeTooltip = tooltip;
    const clipId = `chart-clip-${nextChartId++}`;
    const defs = svgElement('defs');
    const clip = svgElement('clipPath', { id: clipId });
    clip.append(svgElement('rect', { x: layout.left, y: layout.top, width: layout.right - layout.left, height: layout.bottom - layout.top }));
    defs.append(clip);
    svg.append(defs);
    const marks = svgElement('g', { class: 'chart-marks', 'clip-path': `url(#${clipId})` });
    const renderer = getRenderer(chartSpec.type);
    const visibleSeriesCount = Math.max(1, visible.length);
    const maxSeriesPoints = Math.max(1, ...visible.map(series => series.points.length));
    drawn.forEach((series, visibleIndex) => {
      const group = svgElement('g', { class: `chart-series chart-series-${series.index}` });
      const groupWidth = x.type === 'category' ? x.step * 0.78 : Math.max(4, (layout.right - layout.left) / maxSeriesPoints) * 0.78;
      const stacked = chartSpec.options.mode === 'stacked';
      const seriesOffset = visibleSeriesCount === 1 || stacked ? 0 : (visibleIndex - (visibleSeriesCount - 1) / 2) * (groupWidth / visibleSeriesCount);
      renderer(group, series, { x, y, layout, tooltip: activeTooltip, visibleSeriesCount, maxSeriesPoints, seriesOffset, stacked, allPoints: drawn.flatMap(item => item.points) });
      marks.append(group);
    });
    svg.append(marks);
    renderReferenceLines(svg, layout, y, chartSpec.options.hlines, 'h');
    renderReferenceLines(svg, layout, x, chartSpec.options.vlines, 'v');
    surface.append(svg);
    interactionContext = {
      enabled: zoomEnabled,
      bounds: bounds ?? { x: [0, 1], y: [0, 1] },
      domains: domains ?? { x: [0, 1], y: [0, 1] },
      layout,
      svg,
      x: x.type === 'linear' ? x : numericScaleFallback(),
      y: y.type === 'linear' ? y : numericScaleFallback(),
    };
    if (zoomEnabled) renderZoomControls(surface, isZoomed(), resetZoom);
    const ruleExtras = labeledRuleExtras(chartSpec.options);
    if (chartSpec.options.legend && (chartSpec.series.length > 1 || ruleExtras.length)) {
      renderLegend(surface, chartSpec.series.map((series, index) => ({ ...series, color: colorAt(index) })), hidden, drawSoon, ruleExtras);
    }
  };

  const changeZoom = (next: ZoomDomains) => {
    domains = next;
    drawSoon();
  };
  const resetZoom = () => {
    domains = bounds ? { x: [bounds.x[0], bounds.x[1]], y: [bounds.y[0], bounds.y[1]] } : null;
    drawSoon();
  };
  const interactionCleanup = createZoomInteraction(host, () => interactionContext, changeZoom, resetZoom);
  animation?.setRedraw(drawSoon);
  draw();
  animation?.start();
  if (typeof ResizeObserver !== 'undefined' && chartSpec.options.width == null) {
    observer = new ResizeObserver(drawSoon);
    observer.observe(host);
  }
  return () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    interactionCleanup();
    animation?.cleanup();
    tooltip?.remove();
  };

  function isZoomed(): boolean {
    return Boolean(zoomEnabled && domains && bounds && (!domainsEqual(domains.x, bounds.x) || !domainsEqual(domains.y, bounds.y)));
  }
}

const FIGURE_ZERO_MARKS = new Set(['bar', 'area', 'histogram']);

export function renderFigure(host: HTMLElement, spec: RenderableChartSpec): () => void {
  if (Array.isArray(spec.panels)) return renderFacet(host, spec);
  const items = flattenFigureItems(spec.layers ?? []);
  const hidden = new Set<number>();
  const anim = spec.options.anim;
  const animation = shouldAnimate(Boolean(spec.options.animate), 'figure', FIGURE_ANIMATABLE_TYPES)
    ? createAnimationController(host, { duration: anim?.durationMs, loop: anim?.loop, speed: anim?.speed, autoplay: anim?.autoplay })
    : null;
  const surface = animation ? animation.stage : host;
  let observer: ResizeObserver | null = null;
  let tooltip: TooltipApi | null = null;
  let frame = 0;
  const drawSoon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };

  const draw = () => {
    tooltip?.remove();
    surface.innerHTML = '';
    host.className = 'chart-view';
    const width = spec.options.width ?? Math.max(320, host.clientWidth || 720);
    const height = chartHeight(width, spec.options.height);
    const compact = width < 520;
    host.classList.toggle('chart-compact', compact);
    const visible = items.filter(item => !hidden.has(item.index));
    const hasRight = visible.some(item => item.axis === 'right');
    const layout = {
      width,
      height,
      frameRight: width,
      left: compact ? 44 : 58,
      right: width - (hasRight ? (compact ? 44 : 58) : 16),
      top: spec.options.title ? 42 : 20,
      bottom: height - (compact ? 42 : 48),
    };
    const svg = svgElement('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img' });
    if (spec.options.title) svg.append(svgText(spec.options.title, { class: 'chart-title', x: layout.left, y: 24 }));
    if (spec.options.width != null) svg.style.width = `${width}px`;
    tooltip = createTooltip(host);
    const activeTooltip = tooltip;
    const scales = figureScales(visible, layout);
    renderAxes(svg, layout, scales.x, scales.y, { x: spec.options.xLabel, y: spec.options.yLabel });
    if (scales.yRight) renderRightAxis(svg, layout, scales.yRight, spec.options.y2Label);
    paintFigurePanel(svg, layout, visible, scales, activeTooltip, revealFraction(animation, anim));
    renderReferenceLines(svg, layout, scales.y, spec.options.hlines, 'h');
    renderReferenceLines(svg, layout, scales.x, spec.options.vlines, 'v');
    surface.append(svg);
    const ruleExtras = labeledRuleExtras(spec.options);
    if (spec.options.legend && (items.length > 1 || ruleExtras.length)) {
      renderLegend(surface, items.map(item => ({ name: item.series.name, color: item.color })), hidden, drawSoon, ruleExtras);
    }
  };

  animation?.setRedraw(drawSoon);
  draw();
  animation?.start();
  if (typeof ResizeObserver !== 'undefined' && spec.options.width == null) {
    observer = new ResizeObserver(drawSoon);
    observer.observe(host);
  }
  return () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    animation?.cleanup();
    tooltip?.remove();
  };
}

const FIGURE_ANIMATABLE_TYPES = new Set(['figure']);

function renderFacet(host: HTMLElement, spec: RenderableChartSpec): () => void {
  const panels = (spec.panels ?? []).map(panel => ({ label: panel.label, items: flattenFigureItems(panel.layers) }));
  const globalItems = panels.flatMap(panel => panel.items);
  const hidden = new Set<number>();
  let observer: ResizeObserver | null = null;
  let tooltip: TooltipApi | null = null;
  let frame = 0;
  const drawSoon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };

  const draw = () => {
    tooltip?.remove();
    host.innerHTML = '';
    host.className = 'chart-view';
    const width = spec.options.width ?? Math.max(320, host.clientWidth || 720);
    const compact = width < 520;
    host.classList.toggle('chart-compact', compact);
    const minPanelWidth = compact ? 150 : 240;
    const autoCols = Math.max(1, Math.floor(width / minPanelWidth));
    const cols = Math.max(1, Math.min(panels.length, spec.facet?.cols ?? autoCols));
    const rows = Math.ceil(panels.length / cols);
    const cellWidth = width / cols;
    const cellHeight = spec.options.height ? spec.options.height / rows : chartHeight(cellWidth, null);
    const headOffset = spec.options.title ? 34 : 6;
    const height = headOffset + rows * cellHeight;
    const svg = svgElement('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img' });
    if (spec.options.title) svg.append(svgText(spec.options.title, { class: 'chart-title', x: 12, y: 24 }));
    if (spec.options.width != null) svg.style.width = `${width}px`;
    tooltip = createTooltip(host);
    const activeTooltip = tooltip;
    const visibleGlobal = globalItems.filter(item => !hidden.has(item.index));
    panels.forEach((panel, panelIndex) => {
      const col = panelIndex % cols;
      const row = Math.floor(panelIndex / cols);
      const originX = col * cellWidth;
      const originY = headOffset + row * cellHeight;
      const visible = panel.items.filter(item => !hidden.has(item.index));
      const hasRight = visible.some(item => item.axis === 'right');
      const layout = {
        width,
        height,
        frameRight: originX + cellWidth,
        left: originX + (compact ? 40 : 50),
        right: originX + cellWidth - (hasRight ? (compact ? 38 : 48) : 12),
        top: originY + 24,
        bottom: originY + cellHeight - 34,
      };
      const cell = svgElement('g', { class: 'chart-facet-panel' });
      cell.append(svgText(panel.label, { class: 'chart-facet-label', x: layout.left, y: originY + 16 }));
      const scales = figureScales(visibleGlobal, layout);
      renderAxes(cell, layout, scales.x, scales.y, { x: col === 0 ? spec.options.xLabel : null, y: col === 0 ? spec.options.yLabel : null });
      if (scales.yRight) renderRightAxis(cell, layout, scales.yRight, col === cols - 1 ? spec.options.y2Label : null);
      paintFigurePanel(cell, layout, visible, scales, activeTooltip);
      renderReferenceLines(cell, layout, scales.y, spec.options.hlines, 'h');
      renderReferenceLines(cell, layout, scales.x, spec.options.vlines, 'v');
      svg.append(cell);
    });
    host.append(svg);
    const legendItems = panels[0]?.items ?? [];
    if (spec.options.legend && legendItems.length > 1) {
      renderLegend(host, legendItems.map(item => ({ name: item.series.name, color: item.color })), hidden, drawSoon);
    }
  };

  draw();
  if (typeof ResizeObserver !== 'undefined' && spec.options.width == null) {
    observer = new ResizeObserver(drawSoon);
    observer.observe(host);
  }
  return () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    tooltip?.remove();
  };
}

function figureScales(domainItems: FigureItem[], layout: ChartLayout): FigureScales {
  const hasBar = domainItems.some(item => item.mark === 'bar');
  const xValues = domainItems.flatMap(item => item.series.points.map(point => point.x));
  const leftValues = figureAxisValues(domainItems.filter(item => item.axis === 'left'));
  const rightValues = figureAxisValues(domainItems.filter(item => item.axis === 'right'));
  const x = createScale(xValues, layout.left, layout.right, { padding: hasBar ? 0 : 0.03 });
  const y = createScale(leftValues, layout.bottom, layout.top, { zero: domainItems.some(item => item.axis === 'left' && FIGURE_ZERO_MARKS.has(item.mark)), padding: 0.08 });
  const yRight = rightValues.length
    ? createScale(rightValues, layout.bottom, layout.top, { zero: domainItems.some(item => item.axis === 'right' && FIGURE_ZERO_MARKS.has(item.mark)), padding: 0.08 })
    : null;
  return { x, y, yRight };
}

function paintFigurePanel(svg: SVGElement, layout: ChartLayout, visible: FigureItem[], scales: FigureScales, tooltip: TooltipApi, fraction = 1): void {
  const clipId = `chart-clip-${nextChartId++}`;
  const defs = svgElement('defs');
  const clip = svgElement('clipPath', { id: clipId });
  clip.append(svgElement('rect', { x: layout.left, y: layout.top, width: Math.max(0, layout.right - layout.left), height: Math.max(0, layout.bottom - layout.top) }));
  defs.append(clip);
  svg.append(defs);
  const marks = svgElement('g', { class: 'chart-marks', 'clip-path': `url(#${clipId})` });
  const barItems = visible.filter(item => item.mark === 'bar');
  const barCount = Math.max(1, barItems.length);
  const maxBarPoints = Math.max(1, ...barItems.map(item => item.series.points.length));
  const allPoints = visible.flatMap(item => item.series.points);
  visible.forEach(item => {
    const group = svgElement('g', { class: `chart-series chart-series-${item.index}` });
    const stacked = item.mode === 'stacked';
    let seriesOffset = 0;
    if (item.mark === 'bar' && !stacked && barCount > 1) {
      const groupWidth = scales.x.type === 'category' ? scales.x.step * 0.78 : Math.max(4, (layout.right - layout.left) / maxBarPoints) * 0.78;
      seriesOffset = (barItems.indexOf(item) - (barCount - 1) / 2) * (groupWidth / barCount);
    }
    getRenderer(item.mark)(group, { ...item.series, points: revealPoints(item.series.points, fraction, scales.x), color: item.color, index: item.index }, {
      x: scales.x,
      y: item.axis === 'right' ? (scales.yRight ?? scales.y) : scales.y,
      layout,
      tooltip,
      visibleSeriesCount: barCount,
      maxSeriesPoints: maxBarPoints,
      seriesOffset,
      stacked,
      allPoints,
    });
    marks.append(group);
  });
  svg.append(marks);
}

function flattenFigureItems(layers: FigureLayer[]): FigureItem[] {
  const items: FigureItem[] = [];
  let index = 0;
  for (const layer of layers) {
    for (const series of layer.series) {
      items.push({ mark: layer.mark, axis: layer.axis, mode: layer.mode, series, color: colorAt(index), index });
      index++;
    }
  }
  return items;
}

function figureAxisValues(items: FigureItem[]): number[] {
  return items.flatMap(item => item.series.points.flatMap(point => [point.y, point.y0, point.y1].filter(value => value != null)));
}

function chartHeight(width: number, explicit?: number | null): number {
  if (explicit != null) return explicit;
  if (width < 420) return 260;
  if (width < 720) return 310;
  return 360;
}

function numericDomain(scale: ChartScale): [number, number] {
  return scale.type === 'linear' ? scale.domain : [0, 1];
}

function numericScaleFallback(): LinearScale {
  return createScale([0, 1], 0, 1) as LinearScale;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

type MorphPointNode = {
  circle: SVGElement;
  live: ChartPoint;
  series: ChartSeries;
};

type MorphLineNode = {
  path: SVGElement;
};

type MorphPointContext = {
  x: ChartScale;
  y: ChartScale;
  markMaps: ReturnType<typeof indexMarks>[];
  nodeMap: Map<string, MorphPointNode>;
  radius: { min: number; max: number };
};

type MorphLineContext = {
  x: ChartScale;
  y: ChartScale;
  markMaps: LineMarkMap[];
  nodeMap: Map<string, MorphLineNode>;
};

type LineMark = {
  points: ChartPoint[];
  color: string;
};

type LineMarkMap = Map<string, LineMark>;

function renderMorph(host: HTMLElement, spec: RenderableChartSpec): () => void {
  const anim = spec.animation;
  if (!anim) throw new Error('Morph chart is missing animation frames');
  const frames = anim.frames;
  const isLine = spec.type === 'line';
  const allPoints = frames.flatMap(frame => frame.series.flatMap(series => series.points));
  const xValues = allPoints.map(point => point.x);
  const yValues = allPoints.map(point => point.y);
  const maxSize = Math.max(1, ...allPoints.map(point => Math.abs(numberValue(point.size ?? point.value))));
  const frameValues = frames.map(frame => frame.value).filter((value): value is string | number => value != null);
  const reduced = prefersReducedMotion();
  const ease = getEasing(anim.easing);
  const controller = createAnimationController(host, {
    duration: Math.max(1, anim.durationMs) * Math.max(1, frames.length - 1),
    loop: anim.loop,
    speed: anim.speed,
    autoplay: anim.autoplay,
    frameValues,
  });
  const surface = controller.stage;
  let observer: ResizeObserver | null = null;
  let tooltip: TooltipApi | null = null;
  let context: MorphPointContext | MorphLineContext | null = null;

  const tick = (fraction: number) => {
    if (!context) return;
    const { from, to, t } = segmentAt(frames.length, fraction);
    const eased = reduced ? Math.round(t) : ease(t);
    if (isLine) tickLines(context as MorphLineContext, from, to, eased);
    else tickPoints(context as MorphPointContext, from, to, eased, maxSize, spec.type);
  };

  const build = () => {
    tooltip?.remove();
    surface.innerHTML = '';
    const width = spec.options.width ?? Math.max(320, host.clientWidth || 720);
    const height = chartHeight(width, spec.options.height);
    const compact = width < 520;
    host.classList.toggle('chart-compact', compact);
    const layout = { width, height, left: compact ? 44 : 58, right: width - 16, top: spec.options.title ? 42 : 20, bottom: height - (compact ? 42 : 48) };
    const svg = svgElement('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img' });
    if (spec.options.title) svg.append(svgText(spec.options.title, { class: 'chart-title', x: layout.left, y: 24 }));
    if (spec.options.width != null) svg.style.width = `${width}px`;
    const x = createScale(xValues, layout.left, layout.right, { padding: 0.04 });
    const y = createScale(yValues, layout.bottom, layout.top, { padding: 0.08 });
    renderAxes(svg, layout, x, y, { x: spec.options.xLabel, y: spec.options.yLabel });
    tooltip = createTooltip(host);
    const activeTooltip = tooltip;
    const clipId = `chart-clip-${nextChartId++}`;
    const defs = svgElement('defs');
    const clip = svgElement('clipPath', { id: clipId });
    clip.append(svgElement('rect', { x: layout.left, y: layout.top, width: layout.right - layout.left, height: layout.bottom - layout.top }));
    defs.append(clip);
    svg.append(defs);
    const marks = svgElement('g', { class: 'chart-marks', 'clip-path': `url(#${clipId})` });
    const built = isLine ? buildLineNodes(frames, marks) : buildPointNodes(frames, marks, activeTooltip, spec.type);
    svg.append(marks);
    renderReferenceLines(svg, layout, y, spec.options.hlines, 'h');
    renderReferenceLines(svg, layout, x, spec.options.vlines, 'v');
    surface.append(svg);
    const baseSeries = frames[0]?.series ?? [];
    const ruleExtras = labeledRuleExtras(spec.options);
    if (spec.options.legend && (baseSeries.length > 1 || ruleExtras.length)) {
      renderLegend(surface, baseSeries.map((series, index) => ({ name: series.name, color: series.color ?? colorAt(index) })), new Set(), () => {}, ruleExtras);
    }
    const radius = compact ? { min: 3, max: 14 } : { min: 4, max: 22 };
    context = isLine
      ? { x, y, markMaps: built.maps as LineMarkMap[], nodeMap: built.nodes as Map<string, MorphLineNode> }
      : { x, y, markMaps: built.maps as ReturnType<typeof indexMarks>[], nodeMap: built.nodes as Map<string, MorphPointNode>, radius };
    tick(controller.fraction());
  };

  controller.setRedraw(() => tick(controller.fraction()));
  build();
  controller.start();
  if (typeof ResizeObserver !== 'undefined' && spec.options.width == null) {
    observer = new ResizeObserver(build);
    observer.observe(host);
  }
  return () => {
    observer?.disconnect();
    controller.cleanup();
    tooltip?.remove();
  };
}

function buildPointNodes(frames: ChartFrame[], marks: SVGElement, tooltip: TooltipApi, type: string): { maps: ReturnType<typeof indexMarks>[]; nodes: Map<string, MorphPointNode> } {
  const maps = frames.map(frame => indexMarks(frame.series));
  const className = type === 'bubble' ? 'chart-bubble-point' : 'chart-scatter-point';
  const nodes = new Map<string, MorphPointNode>();
  for (const key of unionKeys(maps)) {
    const circle = svgElement('circle', { class: className, r: 0, 'fill-opacity': 0 });
    const live: ChartPoint = { x: 0, y: 0 };
    const series: ChartSeries = { name: '', points: [] };
    tooltip.bind(circle, live, series);
    marks.append(circle);
    nodes.set(key, { circle, live, series });
  }
  return { maps, nodes };
}

function buildLineNodes(frames: ChartFrame[], marks: SVGElement): { maps: LineMarkMap[]; nodes: Map<string, MorphLineNode> } {
  const maps = frames.map(frame => {
    const map: LineMarkMap = new Map();
    frame.series.forEach((series, index) => map.set(series.name, { points: series.points, color: series.color ?? colorAt(index) }));
    return map;
  });
  const nodes = new Map<string, MorphLineNode>();
  for (const name of unionKeys(maps)) {
    const path = svgElement('path', { class: 'chart-line', fill: 'none', 'stroke-opacity': 0 });
    marks.append(path);
    nodes.set(name, { path });
  }
  return { maps, nodes };
}

function tickPoints(context: MorphPointContext, from: number, to: number, t: number, maxSize: number, type: string): void {
  const { x, y, markMaps, nodeMap, radius } = context;
  const fromMap = markMaps[from];
  const toMap = markMaps[to];
  for (const [key, node] of nodeMap) {
    const mark = tweenMark(fromMap.get(key), toMap.get(key), t);
    if (mark.opacity <= 0) {
      node.circle.setAttribute('fill-opacity', '0');
      node.circle.setAttribute('r', '0');
      continue;
    }
    const markX = mark.x ?? 0;
    const markY = mark.y ?? 0;
    const r = type === 'bubble' ? radius.min + Math.sqrt(Math.abs(mark.size ?? 0) / maxSize) * (radius.max - radius.min) : SCATTER_RADIUS;
    node.circle.setAttribute('cx', String(x.scale(markX)));
    node.circle.setAttribute('cy', String(y.scale(markY)));
    node.circle.setAttribute('r', String(r));
    node.circle.setAttribute('fill', mark.color ?? '');
    node.circle.setAttribute('fill-opacity', String(mark.opacity));
    node.live.x = markX;
    node.live.y = markY;
    node.live.tooltip = type === 'bubble' ? `x: ${mark.x}  y: ${mark.y}  size: ${mark.point?.value ?? mark.size}` : null;
    node.series.name = mark.name ?? '';
  }
}

function tickLines(context: MorphLineContext, from: number, to: number, t: number): void {
  const { x, y, markMaps, nodeMap } = context;
  const fromMap = markMaps[from];
  const toMap = markMaps[to];
  for (const [name, node] of nodeMap) {
    const a = fromMap.get(name);
    const b = toMap.get(name);
    if (!a && !b) {
    node.path.setAttribute('stroke-opacity', '0');
      continue;
    }
    const source = a ?? b;
    const target = b ?? a;
    if (!source || !target) continue;
    node.path.setAttribute('d', tweenLinePath(source.points, target.points, t, x, y));
    node.path.setAttribute('stroke', a && b ? source.color : target.color);
    node.path.setAttribute('stroke-opacity', String(a && b ? 1 : a ? 1 - t : t));
  }
}

export function layoutSeries(series: ChartSeries[], spec: RenderableChartSpec): ChartSeries[] {
  if (spec.options.mode !== 'stacked') return series;
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

let nextChartId = 1;

function renderZoomControls(host: HTMLElement, zoomed: boolean, reset: () => void): void {
  const controls = document.createElement('div');
  controls.className = 'chart-zoom-controls';
  const hint = document.createElement('span');
  hint.textContent = 'Wheel zoom · drag pan';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reset zoom';
  button.disabled = !zoomed;
  button.addEventListener('click', reset);
  controls.append(hint, button);
  host.append(controls);
}
