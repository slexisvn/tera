import { formatValue } from './svg';
import type { TooltipApi, TooltipPoint, TooltipSeries } from './types';

export function createTooltip(host: HTMLElement): TooltipApi {
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  host.append(tooltip);
  let pinned = false;
  const outside = (event: PointerEvent) => {
    if (!pinned) return;
    if (!(event.target instanceof Node)) return;
    if (tooltip.contains(event.target) || host.contains(event.target)) return;
    hide();
  };
  document.addEventListener('pointerdown', outside, true);
  return {
    bind(element: Element, point: TooltipPoint, series: TooltipSeries) {
      element.addEventListener('pointerenter', (event: Event) => {
        if (!(event instanceof PointerEvent)) return;
        if (!pinned) show(event, point, series);
      });
      element.addEventListener('pointermove', (event: Event) => {
        if (!(event instanceof PointerEvent)) return;
        if (!pinned) move(event);
      });
      element.addEventListener('pointerleave', () => {
        if (!pinned) hide();
      });
      element.addEventListener('pointerdown', (event: Event) => {
        if (!(event instanceof PointerEvent)) return;
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
        event.preventDefault();
        event.stopPropagation();
        pinned = true;
        show(event, point, series);
      });
    },
    track(event: PointerEvent, point: TooltipPoint, series: TooltipSeries) {
      if (!pinned) show(event, point, series);
    },
    hide,
    remove() {
      document.removeEventListener('pointerdown', outside, true);
      tooltip.remove();
    },
  };

  function show(event: PointerEvent, point: TooltipPoint, series: TooltipSeries): void {
    pinned = pinned && (event.pointerType === 'touch' || event.pointerType === 'pen');
    tooltip.innerHTML = '';
    const name = document.createElement('strong');
    name.textContent = series.name;
    const values = document.createElement('span');
    values.textContent = point.tooltip ?? `x: ${formatValue(point.x)}  y: ${formatValue(point.y)}`;
    tooltip.append(name, values);
    tooltip.classList.add('visible');
    move(event);
  }

  function move(event: PointerEvent): void {
    const rect = host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const box = tooltip.getBoundingClientRect();
    let left = x + 12;
    let top = y + 12;
    if (left + box.width > rect.width - 6) left = x - box.width - 12;
    if (top + box.height > rect.height - 6) top = y - box.height - 12;
    tooltip.style.left = `${Math.max(6, left)}px`;
    tooltip.style.top = `${Math.max(6, top)}px`;
  }

  function hide(): void {
    pinned = false;
    tooltip.classList.remove('visible');
  }
}
