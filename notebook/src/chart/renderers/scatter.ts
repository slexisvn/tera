import { svgElement } from '../svg';
import type { RenderContext, ChartSeries } from '../types';

export function renderScatter(root: SVGElement, series: ChartSeries, context: RenderContext): void {
  for (const point of series.points) {
    const circle = svgElement('circle', { class: 'chart-scatter-point', cx: context.x.scale(point.x), cy: context.y.scale(point.y), r: 4, fill: series.color });
    context.tooltip.bind(circle, point, series);
    root.append(circle);
  }
}
