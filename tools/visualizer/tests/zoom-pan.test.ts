import { describe, expect, it } from "vitest";
import { clampScale, fitViewport, zoomAround } from "../src/services/use-zoom-pan";

const IDENTITY = { x: 0, y: 0, k: 1 };

function contentUnder(view: { x: number; y: number; k: number }, px: number, py: number) {
  return { x: (px - view.x) / view.k, y: (py - view.y) / view.k };
}

describe("zooming around a point", () => {
  it("keeps the content under the cursor pinned there", () => {
    const before = contentUnder(IDENTITY, 300, 200);
    const after = zoomAround(IDENTITY, 300, 200, 2.5);

    expect(contentUnder(after, 300, 200).x).toBeCloseTo(before.x, 9);
    expect(contentUnder(after, 300, 200).y).toBeCloseTo(before.y, 9);
  });

  it("keeps it pinned when zooming out of an already panned view", () => {
    const panned = { x: -140, y: 60, k: 1.8 };
    const before = contentUnder(panned, 90, 410);
    const after = zoomAround(panned, 90, 410, 0.4);

    expect(after.k).toBeCloseTo(0.4, 9);
    expect(contentUnder(after, 90, 410).x).toBeCloseTo(before.x, 9);
    expect(contentUnder(after, 90, 410).y).toBeCloseTo(before.y, 9);
  });

  it("returns the same viewport when the scale does not move", () => {
    expect(zoomAround(IDENTITY, 10, 10, 1)).toBe(IDENTITY);
  });

  it("refuses to zoom past the limits, and stops moving once clamped", () => {
    expect(clampScale(500).valueOf()).toBe(5);
    expect(clampScale(0.0001).valueOf()).toBe(0.15);
    expect(zoomAround({ x: 0, y: 0, k: 5 }, 10, 10, 99)).toEqual({ x: 0, y: 0, k: 5 });
  });
});

describe("fitting a graph into its surface", () => {
  it("scales a graph larger than the box down until it fits, with a margin", () => {
    const view = fitViewport({ width: 400, height: 300 }, { width: 1000, height: 500 })!;

    expect(view.k).toBeCloseTo((400 - 32) / 1000, 9);
    expect(1000 * view.k).toBeLessThanOrEqual(400);
    expect(500 * view.k).toBeLessThanOrEqual(300);
  });

  it("fits against whichever axis is tighter", () => {
    const view = fitViewport({ width: 4000, height: 600 }, { width: 1000, height: 2000 })!;

    expect(view.k).toBeCloseTo((600 - 32) / 2000, 9);
  });

  it("stops shrinking at the minimum scale, leaving a huge graph to be panned", () => {
    const view = fitViewport({ width: 4000, height: 300 }, { width: 1000, height: 2000 })!;

    expect((300 - 32) / 2000).toBeLessThan(0.15);
    expect(view.k).toBe(0.15);
  });

  it("never magnifies a graph that already fits", () => {
    expect(fitViewport({ width: 900, height: 900 }, { width: 100, height: 80 })!.k).toBe(1);
  });

  it("centres the graph horizontally", () => {
    const box = { width: 800, height: 600 };
    const view = fitViewport(box, { width: 400, height: 200 })!;

    expect(view.x + (400 * view.k) / 2).toBeCloseTo(box.width / 2, 9);
  });

  it("answers null when either side has no area to fit into", () => {
    expect(fitViewport({ width: 0, height: 300 }, { width: 10, height: 10 })).toBeNull();
    expect(fitViewport({ width: 300, height: 300 }, { width: 0, height: 10 })).toBeNull();
  });
});
