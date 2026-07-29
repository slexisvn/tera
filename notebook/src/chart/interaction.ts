import { panDomain, zoomDomain } from './zoom';
import type { ChartLayout, LinearScale } from './types';
import type { NumericDomain } from './zoom';

type PointerPosition = {
  x: number;
  y: number;
};

type ZoomDomains = {
  x: NumericDomain;
  y: NumericDomain;
};

type ZoomContext = {
  enabled: boolean;
  bounds: ZoomDomains;
  domains: ZoomDomains;
  layout: ChartLayout & { width: number; height: number };
  svg: SVGElement;
  x: LinearScale;
  y: LinearScale;
};

type PointerGeometry = {
  distance: number;
  midpoint: PointerPosition;
};

type PinchState = PointerGeometry & {
  domains: ZoomDomains;
};

export function createZoomInteraction(host: HTMLElement, getContext: () => ZoomContext | null, onChange: (domains: ZoomDomains) => void, onReset: () => void): () => void {
  let dragging = false;
  let last: PointerPosition | null = null;
  const pointers = new Map<number, PointerPosition>();
  let pinch: PinchState | null = null;

  const wheel = (event: WheelEvent) => {
    const context = activeContext(event);
    if (!context) return;
    event.preventDefault();
    const point = svgPoint(event, context);
    const factor = Math.exp(event.deltaY * 0.0015);
    onChange({
      x: zoomDomain(context.domains.x, context.x.invert(point.x), factor, context.bounds.x),
      y: zoomDomain(context.domains.y, context.y.invert(point.y), factor, context.bounds.y),
    });
  };

  const pointerDown = (event: PointerEvent) => {
    const context = activeContext(event);
    if (event.button !== 0 || !context) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { host.setPointerCapture?.(event.pointerId); } catch {}
    if (pointers.size >= 2) {
      dragging = false;
      last = null;
      pinch = pinchState(context);
      host.classList.add('chart-panning');
      return;
    }
    dragging = true;
    last = { x: event.clientX, y: event.clientY };
    host.classList.add('chart-panning');
  };

  const pointerMove = (event: PointerEvent) => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      const context = getContext();
      if (!context?.enabled || !pinch) return;
      event.preventDefault();
      const current = twoPointerGeometry();
      if (!current || pinch.distance <= 0 || current.distance <= 0) return;
      const midpoint = svgClientPoint(current.midpoint.x, current.midpoint.y, context);
      const dx = current.midpoint.x - pinch.midpoint.x;
      const dy = current.midpoint.y - pinch.midpoint.y;
      const rect = context.svg.getBoundingClientRect();
      const xSpan = pinch.domains.x[1] - pinch.domains.x[0];
      const ySpan = pinch.domains.y[1] - pinch.domains.y[0];
      const factor = pinch.distance / current.distance;
      const zoomedX = zoomDomain(pinch.domains.x, context.x.invert(midpoint.x), factor, context.bounds.x);
      const zoomedY = zoomDomain(pinch.domains.y, context.y.invert(midpoint.y), factor, context.bounds.y);
      onChange({
        x: panDomain(zoomedX, -dx / rect.width * xSpan, context.bounds.x),
        y: panDomain(zoomedY, dy / rect.height * ySpan, context.bounds.y),
      });
      return;
    }
    if (!dragging || !last) return;
    const context = getContext();
    if (!context?.enabled) return;
    event.preventDefault();
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    last = { x: event.clientX, y: event.clientY };
    const rect = context.svg.getBoundingClientRect();
    const xSpan = context.domains.x[1] - context.domains.x[0];
    const ySpan = context.domains.y[1] - context.domains.y[0];
    onChange({
      x: panDomain(context.domains.x, -dx / rect.width * xSpan, context.bounds.x),
      y: panDomain(context.domains.y, dy / rect.height * ySpan, context.bounds.y),
    });
  };

  const pointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    try { host.releasePointerCapture?.(event.pointerId); } catch {}
    if (pointers.size >= 2) {
      const context = getContext();
      pinch = context?.enabled ? pinchState(context) : null;
      return;
    }
    if (pointers.size === 1) {
      const point = [...pointers.values()][0];
      dragging = true;
      last = { ...point };
      pinch = null;
      return;
    }
    dragging = false;
    last = null;
    pinch = null;
    host.classList.remove('chart-panning');
  };

  const doubleClick = (event: MouseEvent) => {
    if (!activeContext(event)) return;
    event.preventDefault();
    onReset();
  };

  host.addEventListener('wheel', wheel, { passive: false });
  host.addEventListener('pointerdown', pointerDown);
  host.addEventListener('pointermove', pointerMove);
  host.addEventListener('pointerup', pointerUp);
  host.addEventListener('pointercancel', pointerUp);
  host.addEventListener('dblclick', doubleClick);

  return () => {
    host.removeEventListener('wheel', wheel);
    host.removeEventListener('pointerdown', pointerDown);
    host.removeEventListener('pointermove', pointerMove);
    host.removeEventListener('pointerup', pointerUp);
    host.removeEventListener('pointercancel', pointerUp);
    host.removeEventListener('dblclick', doubleClick);
  };

  function activeContext(event: MouseEvent): ZoomContext | null {
    const context = getContext();
    if (!context?.enabled) return null;
    const point = svgPoint(event, context);
    return point.x >= context.layout.left && point.x <= context.layout.right
      && point.y >= context.layout.top && point.y <= context.layout.bottom
      ? context
      : null;
  }

  function pinchState(context: ZoomContext): PinchState | null {
    const geometry = twoPointerGeometry();
    if (!geometry) return null;
    return {
      distance: geometry.distance,
      midpoint: geometry.midpoint,
      domains: { x: [context.domains.x[0], context.domains.x[1]], y: [context.domains.y[0], context.domains.y[1]] },
    };
  }

  function twoPointerGeometry(): PointerGeometry | null {
    const points = [...pointers.values()];
    if (points.length < 2) return null;
    const a = points[0];
    const b = points[1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return {
      distance: Math.hypot(dx, dy),
      midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }
}

function svgPoint(event: MouseEvent, context: ZoomContext): PointerPosition {
  return svgClientPoint(event.clientX, event.clientY, context);
}

function svgClientPoint(clientX: number, clientY: number, context: ZoomContext): PointerPosition {
  const rect = context.svg.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / rect.width * context.layout.width,
    y: (clientY - rect.top) / rect.height * context.layout.height,
  };
}
