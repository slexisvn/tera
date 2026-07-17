import { colorAt } from './palette';
import { createScale } from './scales';
import { svgElement, svgText, formatValue } from './svg';
import { createTooltip } from './tooltip';
import type { CategoryScale, LinearScale } from './types';

type ChartLayout = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type PayloadStep = {
  name: string;
  value: number;
  rate: number;
  start: number;
  end: number;
};

type FunnelPayload = {
  steps?: PayloadStep[];
};

type WaterfallPayload = {
  steps?: PayloadStep[];
};

type DistributionPoint = {
  x: number;
  y: number;
};

type DistributionSummary = {
  low: number;
  high: number;
  q1: number;
  q3: number;
  median: number;
  outliers: number[];
};

type DistributionGroup = {
  name: string;
  count: number;
  missing: number;
  summary?: DistributionSummary;
  density?: {
    points: DistributionPoint[];
  };
};

type MatrixCell = {
  x: string;
  y: string;
  value: number;
  count?: number;
};

type MatrixPayload = {
  columns?: string[];
  rows?: string[];
  cells: MatrixCell[];
  method?: string;
};

type PayloadChartSpec = {
  family: 'matrix' | 'funnel' | 'waterfall' | 'distribution';
  type: string;
  payload: FunnelPayload | WaterfallPayload | DistributionGroup[] | MatrixPayload;
  options: {
    width?: number;
    height?: number;
    title?: string;
  };
};

type TooltipCleanup = () => void;

export function renderPayloadChart(host: HTMLElement, spec: PayloadChartSpec): TooltipCleanup {
  let observer: ResizeObserver | null = null;
  let frame = 0;
  let tooltipCleanup: TooltipCleanup | null = null;

  const drawSoon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };

  const draw = () => {
    tooltipCleanup?.();
    host.innerHTML = '';
    host.className = 'chart-view';
    const width = spec.options.width ?? Math.max(320, host.clientWidth || 720);
    const height = chartHeight(width, spec.options.height);
    const svg = svgElement('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img' });
    if (spec.options.title) svg.append(svgText(spec.options.title, { class: 'chart-title', x: 58, y: 24 }));
    if (spec.family === 'matrix') renderMatrix(svg, spec.payload as MatrixPayload, width, height);
    else if (spec.family === 'funnel') renderFunnel(svg, spec.payload as FunnelPayload, width, height);
    else if (spec.family === 'waterfall') renderWaterfall(svg, spec.payload as WaterfallPayload, width, height);
    else tooltipCleanup = renderDistribution(svg, spec.type, spec.payload as DistributionGroup[], width, height, host);
    if (spec.options.width != null) svg.style.width = `${width}px`;
    host.append(svg);
  };

  draw();
  if (typeof ResizeObserver !== 'undefined' && spec.options.width == null) {
    observer = new ResizeObserver(drawSoon);
    observer.observe(host);
  }
  return () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    tooltipCleanup?.();
  };
}

function renderFunnel(svg: SVGElement, payload: FunnelPayload, width: number, height: number): void {
  const compact = width < 520;
  const layout = { left: compact ? 28 : 58, right: width - (compact ? 18 : 28), top: 48, bottom: height - 38 };
  const steps = payload.steps || [];
  if (!steps.length) return;
  const max = Math.max(1, ...steps.map(step => Math.abs(step.value)));
  const rowHeight = (layout.bottom - layout.top) / steps.length;
  const center = (layout.left + layout.right) / 2;
  const maxWidth = layout.right - layout.left;
  const minWidth = Math.min(maxWidth * 0.42, compact ? 92 : 150);
  steps.forEach((step, index) => {
    const y = layout.top + index * rowHeight + rowHeight * 0.18;
    const h = Math.max(18, rowHeight * 0.64);
    const scaled = Math.sqrt(Math.abs(step.value) / max);
    const w = Math.max(minWidth, maxWidth * scaled);
    const rect = svgElement('rect', {
      class: 'chart-funnel-step',
      x: center - w / 2,
      y,
      width: w,
      height: h,
      rx: 5,
      fill: colorAt(index),
    });
    const title = svgElement('title');
    title.textContent = `${step.name}: ${formatValue(step.value)} (${formatPercent(step.rate)} of first step)`;
    rect.append(title);
    svg.append(rect);
    const label = compact ? step.name : `${step.name} · ${formatValue(step.value)}`;
    svg.append(svgText(label, { class: 'chart-funnel-label', x: center, y: y + h / 2 + 4, 'text-anchor': 'middle' }));
    if (!compact) {
      svg.append(svgText(formatPercent(step.rate), { class: 'chart-funnel-rate', x: layout.right, y: y + h / 2 + 4, 'text-anchor': 'end' }));
    }
  });
}

function renderWaterfall(svg: SVGElement, payload: WaterfallPayload, width: number, height: number): void {
  const compact = width < 520;
  const layout = { left: compact ? 44 : 58, right: width - 18, top: 48, bottom: height - (compact ? 44 : 58) };
  const steps = payload.steps || [];
  if (!steps.length) return;
  const values = steps.flatMap(step => [step.start, step.end, 0]);
  const x = createScale(steps.map(step => step.name), layout.left, layout.right) as CategoryScale;
  const y = createScale(values, layout.bottom, layout.top, { zero: true, padding: 0.08 }) as LinearScale;
  renderSimpleAxes(svg, layout, x, y);
  const zero = y.scale(0);
  const barWidth = Math.min(48, Math.max(12, x.step * 0.58));
  svg.append(svgElement('line', { class: 'chart-waterfall-zero', x1: layout.left, x2: layout.right, y1: zero, y2: zero }));
  steps.forEach((step, index) => {
    const xCenter = x.scale(step.name);
    const y0 = y.scale(step.start);
    const y1 = y.scale(step.end);
    const top = Math.min(y0, y1);
    const heightValue = Math.max(1, Math.abs(y1 - y0));
    const positive = step.value >= 0;
    const rect = svgElement('rect', {
      class: `chart-waterfall-bar ${positive ? 'positive' : 'negative'}`,
      x: xCenter - barWidth / 2,
      y: top,
      width: barWidth,
      height: heightValue,
      fill: positive ? colorAt(2) : colorAt(3),
    });
    const title = svgElement('title');
    title.textContent = `${step.name}: ${formatValue(step.value)} (total ${formatValue(step.end)})`;
    rect.append(title);
    svg.append(rect);
    if (index > 0) {
      const prevX = x.scale(steps[index - 1].name) + barWidth / 2;
      svg.append(svgElement('line', { class: 'chart-waterfall-connector', x1: prevX, x2: xCenter - barWidth / 2, y1: y.scale(step.start), y2: y.scale(step.start) }));
    }
  });
}

function renderDistribution(
  svg: SVGElement,
  type: string,
  groups: DistributionGroup[],
  width: number,
  height: number,
  host: HTMLElement,
): TooltipCleanup {
  const layout = { left: 58, right: width - 20, top: 42, bottom: height - 48 };
  const values = groups.flatMap(group => {
    const summaryValues = group.summary ? [group.summary.low, group.summary.high, ...group.summary.outliers] : [];
    const densityValues = type === 'violin' ? (group.density?.points ?? []).map(point => point.x) : [];
    return [...summaryValues, ...densityValues];
  });
  const y = createScale(values, layout.bottom, layout.top, { padding: 0.1 }) as LinearScale;
  const x = createScale(groups.map(group => group.name), layout.left, layout.right) as CategoryScale;
  const tooltip = createTooltip(host);
  renderSimpleAxes(svg, layout, x, y);
  groups.forEach((group, index) => {
    if (!group.summary) return;
    const center = x.scale(group.name);
    const widthValue = Math.min(48, x.step * 0.55);
    const color = colorAt(index);
    if (type === 'violin' && group.density?.points.length) {
      const maxDensity = Math.max(...group.density.points.map(point => point.y));
      const right = group.density.points.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${center + point.y / maxDensity * widthValue / 2},${y.scale(point.x)}`).join(' ');
      const left = [...group.density.points].reverse().map(point => `L${center - point.y / maxDensity * widthValue / 2},${y.scale(point.x)}`).join(' ');
      svg.append(svgElement('path', { class: 'chart-violin', d: `${right}${left}Z`, fill: color, stroke: color }));
    }
    const summary = group.summary;
    const rect = svgElement('rect', { class: 'chart-box', x: center - widthValue / 4, y: y.scale(summary.q3), width: widthValue / 2, height: Math.max(1, y.scale(summary.q1) - y.scale(summary.q3)), fill: color });
    const tooltipPoint = { x: group.name, y: summary.median, tooltip: `count: ${group.count}  missing: ${group.missing}  q1: ${formatValue(summary.q1)}  median: ${formatValue(summary.median)}  q3: ${formatValue(summary.q3)}` };
    tooltip.bind(rect, tooltipPoint, { name: group.name });
    svg.append(svgElement('line', { class: 'chart-box-line', x1: center, x2: center, y1: y.scale(summary.low), y2: y.scale(summary.high) }));
    svg.append(rect);
    svg.append(svgElement('line', { class: 'chart-box-median', x1: center - widthValue / 4, x2: center + widthValue / 4, y1: y.scale(summary.median), y2: y.scale(summary.median) }));
    for (const outlier of summary.outliers) svg.append(svgElement('circle', { class: 'chart-box-outlier', cx: center, cy: y.scale(outlier), r: 2.5, fill: color }));
  });
  return () => tooltip.remove();
}

function renderMatrix(svg: SVGElement, payload: MatrixPayload, width: number, height: number): void {
  const layout = { left: 90, right: width - 20, top: 55, bottom: height - 65 };
  const columns = payload.columns || [];
  const rows = payload.rows || payload.columns || [];
  const columnCount = Math.max(1, columns.length);
  const rowCount = Math.max(1, rows.length);
  const cellWidth = (layout.right - layout.left) / columnCount;
  const cellHeight = (layout.bottom - layout.top) / rowCount;
  const values = payload.cells.map(cell => Number.isFinite(cell.value) ? cell.value : 0);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  payload.cells.forEach(cell => {
    const column = columns.indexOf(cell.x);
    const row = rows.indexOf(cell.y);
    if (column < 0 || row < 0) return;
    const value = Number.isFinite(cell.value) ? cell.value : 0;
    const rect = svgElement('rect', { class: 'chart-correlation-cell', x: layout.left + column * cellWidth, y: layout.top + row * cellHeight, width: cellWidth, height: cellHeight, fill: matrixColor(value, min, max, payload.method) });
    const title = svgElement('title');
    title.textContent = payload.method
      ? `${cell.y} × ${cell.x}: ${Number.isFinite(cell.value) ? formatValue(cell.value) : 'NaN'} (${payload.method}, n=${cell.count})`
      : `${cell.y} × ${cell.x}: ${Number.isFinite(cell.value) ? formatValue(cell.value) : 'NaN'}`;
    rect.append(title);
    svg.append(rect);
    if (cellWidth >= 38 && cellHeight >= 25) svg.append(svgText(Number.isFinite(cell.value) ? value.toFixed(2) : 'NaN', { class: 'chart-correlation-value', x: layout.left + (column + 0.5) * cellWidth, y: layout.top + (row + 0.5) * cellHeight + 4, 'text-anchor': 'middle' }));
  });
  rows.forEach((row, index) => {
    svg.append(svgText(row, { class: 'chart-matrix-label', x: layout.left - 8, y: layout.top + (index + 0.5) * cellHeight + 4, 'text-anchor': 'end' }));
  });
  columns.forEach((column, index) => {
    svg.append(svgText(column, { class: 'chart-matrix-label', transform: `translate(${layout.left + (index + 0.5) * cellWidth} ${layout.bottom + 8}) rotate(-45)`, 'text-anchor': 'end' }));
  });
}

function renderSimpleAxes(svg: SVGElement, layout: ChartLayout, x: CategoryScale, y: LinearScale): void {
  for (const tick of y.ticks) {
    const position = y.scale(tick);
    svg.append(svgElement('line', { class: 'chart-payload-grid', x1: layout.left, x2: layout.right, y1: position, y2: position }));
    svg.append(svgText(formatValue(tick), { class: 'chart-payload-tick', x: layout.left - 8, y: position + 4, 'text-anchor': 'end' }));
  }
  for (const tick of x.ticks) svg.append(svgText(tick, { class: 'chart-payload-tick', x: x.scale(tick), y: layout.bottom + 20, 'text-anchor': 'middle' }));
}

function chartHeight(width: number, explicit?: number): number {
  if (explicit != null) return explicit;
  if (width < 420) return 260;
  if (width < 720) return 310;
  return 360;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  if (!Number.isFinite(percent)) return '0%';
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

function correlationColor(value: number): string {
  const amount = Math.min(1, Math.abs(value));
  return value < 0 ? `rgba(224,108,117,${0.18 + amount * 0.82})` : `rgba(79,107,237,${0.18 + amount * 0.82})`;
}

function matrixColor(value: number, min: number, max: number, method?: string): string {
  if (method) return correlationColor(value);
  const t = max === min ? 0.5 : (value - min) / (max - min);
  const alpha = 0.18 + Math.max(0, Math.min(1, t)) * 0.82;
  return `rgba(79,107,237,${alpha})`;
}
