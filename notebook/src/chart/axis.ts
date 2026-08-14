import { svgElement, svgText, formatTick } from './svg';
import type { ChartLayout, ChartScale } from './types';

type AxisLabels = {
  x?: string | null;
  y?: string | null;
};

export function renderAxes(root: SVGElement, layout: ChartLayout, xScale: ChartScale, yScale: ChartScale, labels: AxisLabels): void {
  const grid = svgElement('g', { class: 'chart-grid' });
  const axes = svgElement('g', { class: 'chart-axes' });
  for (const tick of yScale.ticks) {
    const y = yScale.scale(tick);
    grid.append(svgElement('line', { x1: layout.left, x2: layout.right, y1: y, y2: y }));
    axes.append(svgText(formatTick(tick), { x: layout.left - 9, y: y + 4, 'text-anchor': 'end' }));
  }
  const xTicks = xScale.type === 'category' && xScale.ticks.length > 12
    ? xScale.ticks.filter((_, index) => index % Math.ceil(xScale.ticks.length / 12) === 0)
    : xScale.ticks;
  for (const tick of xTicks) {
    const x = xScale.scale(tick);
    axes.append(svgElement('line', { x1: x, x2: x, y1: layout.bottom, y2: layout.bottom + 5 }));
    axes.append(svgText(formatTick(tick), { x, y: layout.bottom + 20, 'text-anchor': 'middle' }));
  }
  axes.append(svgElement('line', { x1: layout.left, x2: layout.right, y1: layout.bottom, y2: layout.bottom }));
  axes.append(svgElement('line', { x1: layout.left, x2: layout.left, y1: layout.top, y2: layout.bottom }));
  if (labels.x) axes.append(svgText(labels.x, { class: 'chart-axis-label', x: (layout.left + layout.right) / 2, y: (layout.height ?? layout.bottom) - 8, 'text-anchor': 'middle' }));
  if (labels.y) axes.append(svgText(labels.y, { class: 'chart-axis-label', transform: `translate(16 ${(layout.top + layout.bottom) / 2}) rotate(-90)`, 'text-anchor': 'middle' }));
  root.append(grid, axes);
}

export function renderRightAxis(root: SVGElement, layout: ChartLayout, yScale: ChartScale, label?: string | null): void {
  const axes = svgElement('g', { class: 'chart-axes' });
  for (const tick of yScale.ticks) {
    const y = yScale.scale(tick);
    axes.append(svgText(formatTick(tick), { x: layout.right + 9, y: y + 4, 'text-anchor': 'start' }));
  }
  axes.append(svgElement('line', { x1: layout.right, x2: layout.right, y1: layout.top, y2: layout.bottom }));
  if (label) axes.append(svgText(label, { class: 'chart-axis-label', transform: `translate(${(layout.frameRight ?? layout.width ?? layout.right) - 16} ${(layout.top + layout.bottom) / 2}) rotate(90)`, 'text-anchor': 'middle' }));
  root.append(axes);
}
