import { svgElement } from '../svg.js';

export function renderBar(root, series, context) {
  const width = barWidth(context, false);
  const zero = context.y.scale(0);
  for (const point of series.points) {
    const center = context.x.scale(point.x) + context.seriesOffset;
    const y0 = context.y.scale(point.y0 ?? 0);
    const y = context.y.scale(point.y1 ?? point.y);
    const rect = svgElement('rect', {
      class: 'chart-bar',
      x: center - width / 2,
      y: Math.min(y, point.y0 == null ? zero : y0),
      width,
      height: Math.max(1, Math.abs((point.y0 == null ? zero : y0) - y)),
      fill: series.color,
      rx: 2,
    });
    context.tooltip.bind(rect, point, series);
    root.append(rect);
  }
}

export function renderHistogram(root, series, context) {
  const width = barWidth(context, true);
  const zero = context.y.scale(0);
  for (const point of series.points) {
    const center = context.x.scale(point.x) + context.seriesOffset;
    const y = context.y.scale(point.y);
    const rect = svgElement('rect', {
      class: 'chart-bar',
      x: center - width / 2,
      y,
      width,
      height: Math.max(1, zero - y),
      fill: series.color,
    });
    context.tooltip.bind(rect, point, series);
    root.append(rect);
  }
}

function barWidth(context, histogram) {
  const base = context.x.type === 'category'
    ? context.x.step
    : Math.max(4, (context.layout.right - context.layout.left) / Math.max(1, context.maxSeriesPoints));
  return Math.max(1, base * (histogram ? 0.92 : 0.78) / (context.stacked ? 1 : context.visibleSeriesCount));
}
