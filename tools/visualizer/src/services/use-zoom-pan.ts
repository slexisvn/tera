import { useCallback, useEffect, useRef, useState } from "react";

export type Viewport = {
  readonly x: number;
  readonly y: number;
  readonly k: number;
};

export type FitMode = "width" | "contain";

export type ZoomPan = {
  readonly surface: React.RefObject<SVGSVGElement | null>;
  readonly view: Viewport;
  readonly box: Size;
  readonly panning: boolean;
  wasDragged(): boolean;
  zoomBy(factor: number): void;
  centerOn(x: number, y: number): void;
  fit(): void;
  reset(): void;
};

const MIN_SCALE = 0.15;
const MAX_SCALE = 5;
const WHEEL_SENSITIVITY = 0.0018;
const FIT_MARGIN = 16;
const DRAG_THRESHOLD = 4;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function centeredOn(view: Viewport, box: Size, x: number, y: number): Viewport {
  if (box.width === 0 || box.height === 0) return view;
  return { k: view.k, x: box.width / 2 - x * view.k, y: box.height / 2 - y * view.k };
}

export function zoomAround(view: Viewport, px: number, py: number, scale: number): Viewport {
  const k = clampScale(scale);
  if (k === view.k) return view;
  return {
    k,
    x: px - ((px - view.x) / view.k) * k,
    y: py - ((py - view.y) / view.k) * k,
  };
}

export function fitViewport(box: Size, natural: Size, mode: FitMode): Viewport | null {
  if (natural.width === 0 || natural.height === 0) return null;
  if (box.width === 0 || box.height === 0) return null;
  const byWidth = (box.width - FIT_MARGIN * 2) / natural.width;
  const byHeight = (box.height - FIT_MARGIN * 2) / natural.height;
  const k = clampScale(mode === "width" ? Math.min(byWidth, 1) : Math.min(byWidth, byHeight, 1));
  return { k, x: (box.width - natural.width * k) / 2, y: FIT_MARGIN };
}

type Size = { readonly width: number; readonly height: number };

function capturePointerIfPresent(node: Element, pointerId: number): void {
  try {
    node.setPointerCapture(pointerId);
  } catch {
    return;
  }
}

export function useZoomPan(natural: Size, mode: FitMode): ZoomPan {
  const surface = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
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

  const settled = useRef<Viewport | null>(null);
  const latest = useRef(view);
  latest.current = view;

  const fit = useCallback(() => {
    const measured = surface.current?.getBoundingClientRect();
    if (measured === undefined) return;
    setBox({ width: measured.width, height: measured.height });
    const next = fitViewport(measured, natural, mode);
    if (next === null) return;
    settled.current = next;
    setView(next);
  }, [mode, natural.height, natural.width]);

  const reset = useCallback(() => setView({ x: 0, y: 0, k: 1 }), []);

  const centerOn = useCallback((x: number, y: number) => {
    const measured = surface.current?.getBoundingClientRect();
    if (measured === undefined) return;
    setView((current) => {
      const next = centeredOn(current, measured, x, y);
      settled.current = next;
      return next;
    });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const measured = surface.current?.getBoundingClientRect();
    if (measured === undefined) return;
    setView((current) => zoomAround(current, measured.width / 2, measured.height / 2, current.k * factor));
  }, []);

  useEffect(() => {
    settled.current = null;
    fit();
    const node = surface.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect;
      if (measured !== undefined) setBox({ width: measured.width, height: measured.height });
      const framed = settled.current;
      const now = latest.current;
      if (framed === null || (now.k === framed.k && now.x === framed.x && now.y === framed.y)) {
        fit();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fit]);

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
        capturePointerIfPresent(node, event.pointerId);
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

  return { surface, view, box, panning, wasDragged, zoomBy, centerOn, fit, reset };
}
