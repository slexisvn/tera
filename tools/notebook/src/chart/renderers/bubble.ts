import { svgElement } from '../svg';
import type { RenderContext, ChartSeries } from '../types';

export function renderBubble(root: SVGElement, series: ChartSeries, context: RenderContext): void {
  const maxSize = Math.max(1, ...context.allPoints.map(point => Math.abs(sizeValue(point.size ?? point.value))));
  const width = context.layout.width ?? context.layout.right - context.layout.left;
  const minRadius = width < 520 ? 3 : 4;
  const maxRadius = width < 520 ? 14 : 22;
  for (const point of series.points) {
    const amount = Math.sqrt(Math.abs(sizeValue(point.size ?? point.value)) / maxSize);
    const circle = svgElement('circle', {
      class: 'chart-bubble-point',
      cx: context.x.scale(point.x),
      cy: context.y.scale(point.y),
      r: minRadius + amount * (maxRadius - minRadius),
      fill: series.color,
    });
    context.tooltip.bind(circle, {
      ...point,
      tooltip: `x: ${point.x}  y: ${point.y}  size: ${point.value ?? point.size}`,
    }, series);
    root.append(circle);
  }
}

function sizeValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}
