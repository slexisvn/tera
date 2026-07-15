import { svgElement } from '../svg.js';

const DENSE_POINT_LIMIT = 80;

export function renderLine(root, series, context) {
  const scaled = series.points.map(point => ({ point, px: context.x.scale(point.x), py: context.y.scale(point.y) }));
  const path = scaled.map((item, index) => `${index === 0 ? 'M' : 'L'}${item.px},${item.py}`).join(' ');
  const attrs = { class: 'chart-line', d: path, stroke: series.color };
  if (series.dash) attrs['stroke-dasharray'] = '6 4';
  root.append(svgElement('path', attrs));
  if (series.points.length > DENSE_POINT_LIMIT) {
    renderDenseHover(root, series, context, scaled);
    return;
  }
  for (const item of scaled) {
    const halo = svgElement('circle', { class: 'chart-point-halo', cx: item.px, cy: item.py, r: 9, fill: 'transparent' });
    const circle = svgElement('circle', { class: 'chart-point chart-point-visible', cx: item.px, cy: item.py, r: 3, fill: series.color });
    context.tooltip.bind(halo, item.point, series);
    context.tooltip.bind(circle, item.point, series);
    root.append(halo);
    root.append(circle);
  }
}

function renderDenseHover(root, series, context, scaled) {
  const { layout, tooltip } = context;
  const spanX = Math.max(1, layout.right - layout.left);
  const highlight = svgElement('circle', { class: 'chart-line-highlight', cx: 0, cy: 0, r: 4, fill: series.color, opacity: 0 });
  const hit = svgElement('rect', {
    x: layout.left, y: layout.top,
    width: spanX, height: Math.max(0, layout.bottom - layout.top),
    fill: 'transparent',
  });
  const nearest = viewX => {
    let best = scaled[0];
    let bestDist = Infinity;
    for (const item of scaled) {
      const dist = Math.abs(item.px - viewX);
      if (dist < bestDist) { bestDist = dist; best = item; }
    }
    return best;
  };
  const onMove = event => {
    const rect = hit.getBoundingClientRect();
    const viewX = layout.left + (event.clientX - rect.left) * (spanX / (rect.width || spanX));
    const item = nearest(viewX);
    highlight.setAttribute('cx', item.px);
    highlight.setAttribute('cy', item.py);
    highlight.setAttribute('opacity', 1);
    tooltip.track(event, item.point, series);
  };
  hit.addEventListener('pointermove', onMove);
  hit.addEventListener('pointerenter', onMove);
  hit.addEventListener('pointerleave', () => { highlight.setAttribute('opacity', 0); tooltip.hide(); });
  root.append(hit);
  root.append(highlight);
}
