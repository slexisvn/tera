import { useCallback, useEffect, useRef, useState } from "react";

export type Viewport = {
  readonly x: number;
  readonly y: number;
  readonly k: number;
};

export type ZoomPan = {
  readonly surface: React.RefObject<SVGSVGElement | null>;
  readonly view: Viewport;
  readonly panning: boolean;
  /** True while the gesture that just ended was a drag, not a tap. */
  wasDragged(): boolean;
  zoomBy(factor: number): void;
  fit(): void;
  reset(): void;
};

const MIN_SCALE = 0.15;
const MAX_SCALE = 5;
const WHEEL_SENSITIVITY = 0.0018;
const FIT_MARGIN = 16;
// Below this much movement the gesture is a tap on a node, not a pan.
const DRAG_THRESHOLD = 4;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Rescale so the content under (px, py) stays under (px, py). Both coordinates
 * are relative to the surface, not the page.
 */
export function zoomAround(view: Viewport, px: number, py: number, scale: number): Viewport {
  const k = clampScale(scale);
  if (k === view.k) return view;
  return {
    k,
    x: px - ((px - view.x) / view.k) * k,
    y: py - ((py - view.y) / view.k) * k,
  };
}

/** The viewport that centres `natural` inside a `box`, never magnifying past 1:1. */
export function fitViewport(box: Size, natural: Size): Viewport | null {
  if (natural.width === 0 || natural.height === 0) return null;
  if (box.width === 0 || box.height === 0) return null;
  const k = clampScale(
    Math.min(
      (box.width - FIT_MARGIN * 2) / natural.width,
      (box.height - FIT_MARGIN * 2) / natural.height,
      1,
    ),
  );
  return { k, x: (box.width - natural.width * k) / 2, y: FIT_MARGIN };
}

type Size = { readonly width: number; readonly height: number };

/**
 * Pan and zoom over an SVG surface, driven by pointer events so a mouse drag, a
 * one-finger drag and a two-finger pinch all go through the same path.
 */
export function useZoomPan(natural: Size): ZoomPan {
  const surface = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; k: number } | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  const zoomAt = useCallback((clientX: number, clientY: number, scale: number) => {
    const box = surface.current?.getBoundingClientRect();
    if (box === undefined) return;
    const px = clientX - box.left;
    const py = clientY - box.top;
    setView((current) => zoomAround(current, px, py, scale));
  }, []);

  // What the last fit produced, so a resize can tell "still framed as we left it"
  // from "the reader has moved it" and only re-fit in the first case.
  const settled = useRef<Viewport | null>(null);
  const latest = useRef(view);
  latest.current = view;

  const fit = useCallback(() => {
    const box = surface.current?.getBoundingClientRect();
    if (box === undefined) return;
    const next = fitViewport(box, natural);
    if (next === null) return;
    settled.current = next;
    setView(next);
  }, [natural.height, natural.width]);

  const reset = useCallback(() => setView({ x: 0, y: 0, k: 1 }), []);

  const zoomBy = useCallback(
    (factor: number) => {
      const box = surface.current?.getBoundingClientRect();
      if (box === undefined) return;
      zoomAt(box.left + box.width / 2, box.top + box.height / 2, view.k * factor);
    },
    [view.k, zoomAt],
  );

  // The first fit can land before the surface has been laid out, and rotating a
  // phone changes the box under it, so re-fit on resize until the reader takes over.
  useEffect(() => {
    settled.current = null;
    fit();
    const node = surface.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const framed = settled.current;
      const now = latest.current;
      if (framed === null || (now.k === framed.k && now.x === framed.x && now.y === framed.y)) {
        fit();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fit]);

  // React attaches wheel passively, so the browser would scroll the page behind
  // the canvas; this listener has to be registered by hand to refuse that.
  useEffect(() => {
    const node = surface.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const box = node.getBoundingClientRect();
      setView((current) =>
        zoomAround(
          current,
          event.clientX - box.left,
          event.clientY - box.top,
          current.k * Math.exp(-event.deltaY * WHEEL_SENSITIVITY),
        ),
      );
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const node = surface.current;
    if (node === null) return;

    const midpoint = (): { x: number; y: number; distance: number } => {
      const [first, second] = [...pointers.current.values()];
      return {
        x: (first!.x + second!.x) / 2,
        y: (first!.y + second!.y) / 2,
        distance: Math.hypot(first!.x - second!.x, first!.y - second!.y),
      };
    };

    const onDown = (event: PointerEvent): void => {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2) {
        pinch.current = { distance: midpoint().distance, k: view.k };
        return;
      }
      // No pointer capture yet: capturing here would swallow the click that
      // selects a node, so the gesture has to prove it is a drag first.
      origin.current = { x: event.clientX, y: event.clientY };
      dragged.current = false;
    };

    const onMove = (event: PointerEvent): void => {
      const previous = pointers.current.get(event.pointerId);
      if (previous === undefined) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.current.size >= 2) {
        const held = pinch.current;
        if (held === null) return;
        const now = midpoint();
        if (now.distance > 0 && held.distance > 0) {
          zoomAt(now.x, now.y, held.k * (now.distance / held.distance));
        }
        return;
      }

      const start = origin.current;
      if (start === null) return;
      if (!dragged.current) {
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
        dragged.current = true;
        setPanning(true);
        try {
          node.setPointerCapture(event.pointerId);
        } catch {
          /* the pointer is already gone */
        }
      }

      event.preventDefault();
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    };

    const onUp = (event: PointerEvent): void => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      if (pointers.current.size === 0) {
        origin.current = null;
        setPanning(false);
      }
    };

    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    return () => {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };
  }, [view.k, zoomAt]);

  const wasDragged = useCallback(() => dragged.current, []);

  return { surface, view, panning, wasDragged, zoomBy, fit, reset };
}
