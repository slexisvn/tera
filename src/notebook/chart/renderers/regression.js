import { svgElement } from '../svg.js';

export function renderRegression(root, series, context) {
  if (series.fit) {
    const path = series.points.map((point, index) => `${index ? 'L' : 'M'}${context.x.scale(point.x)},${context.y.scale(point.y)}`).join(' ');
    const line = svgElement('path', { class: 'chart-regression-line', d: path, stroke: series.color });
    if (series.points[0]) context.tooltip.bind(line, series.points[0], series);
    root.append(line);
    return;
  }

  for (const point of series.points) {
    const circle = svgElement('circle', { class: 'chart-scatter-point', cx: context.x.scale(point.x), cy: context.y.scale(point.y), r: 4, fill: series.color });
    context.tooltip.bind(circle, point, series);
    root.append(circle);
  }
}
