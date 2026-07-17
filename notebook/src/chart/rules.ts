import { svgElement, svgText } from './svg';
import type { ChartLayout, ChartOptions, ChartRule, ChartScale } from './types';

const DASH_PATTERN = '6 4';

export function renderReferenceLines(svg: SVGElement, layout: ChartLayout, scale: ChartScale, rules: ChartRule[] | undefined, orientation: 'h' | 'v'): void {
  if (!rules || rules.length === 0) return;
  for (const rule of rules) {
    const pos = scale.scale(rule.value);
    if (!Number.isFinite(pos)) continue;
    const horizontal = orientation === 'h';
    if (horizontal ? (pos < layout.top - 0.5 || pos > layout.bottom + 0.5) : (pos < layout.left - 0.5 || pos > layout.right + 0.5)) continue;
    const coords = horizontal
      ? { x1: layout.left, x2: layout.right, y1: pos, y2: pos }
      : { x1: pos, x2: pos, y1: layout.top, y2: layout.bottom };
    const line = svgElement('line', { class: 'chart-rule', ...coords, stroke: rule.color, 'stroke-width': rule.width });
    if (rule.dash) line.setAttribute('stroke-dasharray', DASH_PATTERN);
    svg.append(line);
    if (rule.label) {
      const label = horizontal
        ? svgText(rule.label, { class: 'chart-rule-label', x: layout.right - 4, y: pos - 4, 'text-anchor': 'end', fill: rule.color })
        : svgText(rule.label, { class: 'chart-rule-label', x: pos + 4, y: layout.top + 12, fill: rule.color });
      svg.append(label);
    }
  }
}

export function labeledRuleExtras(options: ChartOptions): Array<{ name: string; color: string; dash: boolean }> {
  return [...(options.hlines ?? []), ...(options.vlines ?? [])]
    .filter(rule => rule.label)
    .map(rule => ({ name: rule.label ?? '', color: rule.color, dash: rule.dash }));
}
