import { svgElement } from '../svg';
import type { RenderContext, ChartSeries } from '../types';

export function renderArea(root: SVGElement, series: ChartSeries, context: RenderContext): void {
  if (!series.points.length) return;
  const top = series.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${context.x.scale(point.x)},${context.y.scale(point.y1 ?? point.y)}`).join(' ');
  const bottom = [...series.points].reverse().map(point => `L${context.x.scale(point.x)},${context.y.scale(point.y0 ?? 0)}`).join(' ');
  const path = `${top}${bottom}Z`;
  root.append(svgElement('path', { class: 'chart-area', d: path, fill: series.color, stroke: series.color }));
  for (const point of series.points) {
    const circle = svgElement('circle', { class: 'chart-point', cx: context.x.scale(point.x), cy: context.y.scale(point.y1 ?? point.y), r: 3, fill: series.color });
    context.tooltip.bind(circle, point, series);
    root.append(circle);
  }
}
