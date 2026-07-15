import { svgElement } from '../svg.js';

export function renderBubble(root, series, context) {
  const maxSize = Math.max(1, ...context.allPoints.map(point => Math.abs(point.size ?? point.value ?? 1)));
  const minRadius = context.layout.width < 520 ? 3 : 4;
  const maxRadius = context.layout.width < 520 ? 14 : 22;
  for (const point of series.points) {
    const amount = Math.sqrt(Math.abs(point.size ?? point.value ?? 1) / maxSize);
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
