import type { KeyboardEvent, PointerEvent } from "react";
import type { RegionId } from "../config/panes";

const NUDGE = 16;

type SplitterProps = {
  axis: "x" | "y";
  area: string;
  region: RegionId;
  dir: 1 | -1;
  min: number;
  maxRatio: number;
  label: string;
  onResize: (size: number | null) => void;
};

function sizeOf(handle: HTMLElement, region: RegionId, axis: "x" | "y"): number | null {
  const pane = handle.closest(".workspace")?.querySelector(`[data-region="${region}"]`);
  if (!(pane instanceof HTMLElement)) return null;
  const box = pane.getBoundingClientRect();
  return axis === "x" ? box.width : box.height;
}

function spaceOf(handle: HTMLElement, axis: "x" | "y"): number {
  const workspace = handle.closest(".workspace");
  if (!(workspace instanceof HTMLElement)) return Infinity;
  return axis === "x" ? workspace.clientWidth : workspace.clientHeight;
}

export function Splitter({ axis, area, region, dir, min, maxRatio, label, onResize }: SplitterProps) {
  const resize = (handle: HTMLElement, from: number, delta: number): void => {
    const limit = spaceOf(handle, axis) * maxRatio;
    onResize(Math.max(min, Math.min(limit, from + delta * dir)));
  };

  const start = (event: PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget;
    const from = sizeOf(handle, region, axis);
    if (from === null) return;
    const origin = axis === "x" ? event.clientX : event.clientY;
    event.preventDefault();
    const move = (moved: globalThis.PointerEvent): void => {
      resize(handle, from, (axis === "x" ? moved.clientX : moved.clientY) - origin);
    };
    const done = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      document.body.removeAttribute("data-resizing");
      handle.removeAttribute("data-dragging");
    };
    document.body.setAttribute("data-resizing", "");
    handle.setAttribute("data-dragging", "");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const at = keys.indexOf(event.key);
    if (at < 0) return;
    event.preventDefault();
    const from = sizeOf(event.currentTarget, region, axis);
    if (from === null) return;
    resize(event.currentTarget, from, at === 0 ? -NUDGE : NUDGE);
  };

  return (
    <div
      className="splitter"
      style={{ gridArea: area }}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      title={`Drag to resize — ${label}. Double-click to reset.`}
      onPointerDown={start}
      onKeyDown={nudge}
      onDoubleClick={() => onResize(null)}
    />
  );
}
