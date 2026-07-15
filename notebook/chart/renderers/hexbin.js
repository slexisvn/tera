import { svgElement } from '../svg.js';

export function renderHexbin(root, series, context) {
  const max = Math.max(1, ...series.points.map(point => point.count));
  for (const point of series.points) {
    const cx = context.x.scale(point.x);
    const cy = context.y.scale(point.y);
    const radius = hexRadius(point, context);
    const points = regularHexagonPoints(cx, cy, radius);
    const polygon = svgElement('polygon', { class: 'chart-hexbin', points, fill: series.color, 'fill-opacity': 0.15 + 0.85 * point.count / max });
    context.tooltip.bind(polygon, { ...point, tooltip: `count: ${point.count}  x: ${formatRange(point.x0, point.x1)}  y: ${formatRange(point.y0, point.y1)}` }, series);
    root.append(polygon);
  }
}

export function regularHexagonPoints(cx, cy, radius) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = Math.PI / 3 * index;
    return `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`;
  }).join(' ');
}

function hexRadius(point, context) {
  const scaled = Math.abs(context.x.scale(point.x1) - context.x.scale(point.x0)) / 2;
  return Math.max(4, Math.min(24, scaled));
}

function formatRange(min, max) {
  return `${Number(min.toPrecision(4))}–${Number(max.toPrecision(4))}`;
}
