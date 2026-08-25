import { describe, expect, it } from "vitest";
import {
  ARROW_LENGTH,
  ARROW_WIDTH,
  arrowMarkerId,
  dataEdgesInto,
  layoutGraph,
  type Anchor,
  type GraphLayout,
  type RoutedEdge,
} from "../src/services/graph-layout";
import { nodeByKey, parseGraphText } from "../src/services/ir-graph";

const LOOP = `fn work params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1 preds=:
    v1 = Constant [value=3]
    v2 = Jump [targetBlock=1]
  B1 loop-header succs=B2,B3 preds=B0,B2:
    v3 = Phi
    v4 = Branch v3
  B2 succs=B1 preds=B1:
    v5 = Int32Add v3, v1
    v6 = Jump [targetBlock=1]
  B3 succs= preds=B1:
    v7 = Return v3
}
`;

const MERGE = `fn merge params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1,B2,B3,B4 preds=:
    v1 = Constant [value=3]
  B1 succs=B5 preds=B0:
    v2 = Constant [value=1]
  B2 succs=B5 preds=B0:
    v3 = Constant [value=2]
  B3 succs=B5 preds=B0:
    v4 = Constant [value=3]
  B4 succs=B5 preds=B0:
    v5 = Constant [value=4]
  B5 succs=B0 preds=B1,B2,B3,B4:
    v6 = Return v1
}
`;

const SIBLINGS = `fn siblings params=1 {
  B0 succs=B1,B2 preds=:
    v0 = Constant [value=1]
  B1 succs=B2 preds=B0:
    v1 = Constant [value=2]
  B2 succs= preds=B0,B1:
    v2 = Return v1
}
`;

const SELF = `fn spin params=0 {
  B0 succs=B0 preds=B0:
    v0 = Constant [value=1]
}
`;

const REPEATED = `fn twice params=0 {
  B0 succs= preds=:
    v0 = Constant [value=6]
    v1 = Int32Add v0, v0
    v2 = Return v1
}
`;

const SELF_PHI = `fn spin params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1 preds=:
    v1 = Jump [targetBlock=1]
  B1 loop-header succs=B1 preds=B0,B1:
    v2 = Phi v0, v2 [index=0]
    v3 = Jump [targetBlock=1]
}
`;

const EMPTY_BLOCK = `fn gap params=0 {
  B0 succs=B1 preds=:
    v0 = Constant [value=1]
  B1 succs= preds=B0:
}
`;

const CURVE_STEPS = 24;

function layoutOf(text: string): GraphLayout {
  return layoutGraph(parseGraphText(text)!);
}

function blockOf(layout: GraphLayout, label: string) {
  return layout.blocks.find((placed) => placed.block.label === label)!;
}

function edgeOf(layout: GraphLayout, from: string, to: string): RoutedEdge {
  return layout.edges.find((edge) => edge.key.startsWith(`${from}-`) && edge.key.endsWith(`-${to}`))!;
}

type Command = { readonly letter: string; readonly points: readonly Anchor[] };

function commandsOf(path: string): readonly Command[] {
  return [...path.matchAll(/([MLQC])([^MLQC]*)/g)].map((found) => ({
    letter: found[1]!,
    points: [...found[2]!.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((pair) => ({
      x: Number(pair[1]),
      y: Number(pair[2]),
    })),
  }));
}

function at(from: Anchor, to: Anchor, t: number): Anchor {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function flatten(path: string): readonly Anchor[] {
  const points: Anchor[] = [];
  let cursor: Anchor = { x: 0, y: 0 };
  for (const { letter, points: given } of commandsOf(path)) {
    if (letter === "M" || letter === "L") {
      cursor = given[0]!;
      points.push(cursor);
      continue;
    }
    const start = cursor;
    for (let step = 1; step <= CURVE_STEPS; step++) {
      const t = step / CURVE_STEPS;
      const legs = [start, ...given].map((point, index, all) =>
        index === 0 ? point : at(all[index - 1]!, point, t),
      );
      let level = legs.slice(1);
      while (level.length > 1) {
        level = level.slice(1).map((point, index) => at(level[index]!, point, t));
      }
      points.push(level[0]!);
    }
    cursor = given[given.length - 1]!;
  }
  return points;
}

function endOf(path: string): Anchor {
  const points = flatten(path);
  return points[points.length - 1]!;
}

function headingOf(from: Anchor, to: Anchor): Anchor {
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: (to.x - from.x) / span, y: (to.y - from.y) / span };
}

function travelBack(path: string, distance: number): Anchor {
  const points = flatten(path);
  let travelled = 0;
  for (let at = points.length - 1; at > 0; at--) {
    travelled += Math.hypot(points[at]!.x - points[at - 1]!.x, points[at]!.y - points[at - 1]!.y);
    if (travelled >= distance) return points[at - 1]!;
  }
  return points[0]!;
}

function startOf(path: string): Anchor {
  return flatten(path)[0]!;
}

function arrowBaseOf(path: string): Anchor {
  const points = flatten(path);
  let travelled = 0;
  for (let at = points.length - 1; at > 0; at--) {
    travelled += Math.hypot(points[at]!.x - points[at - 1]!.x, points[at]!.y - points[at - 1]!.y);
    if (travelled >= ARROW_LENGTH) return points[at - 1]!;
  }
  return points[0]!;
}

describe("placing the blocks of a printed graph", () => {
  it("puts each block in the row its distance from the entry earns it", () => {
    const layout = layoutOf(LOOP);

    expect(layout.blocks.map((placed) => [placed.block.label, placed.row])).toEqual([
      ["B0", 0],
      ["B1", 1],
      ["B2", 2],
      ["B3", 2],
    ]);
  });

  it("lines blocks of the same row up on one baseline and moves later rows down", () => {
    const layout = layoutOf(LOOP);

    expect(blockOf(layout, "B2").y).toBe(blockOf(layout, "B3").y);
    expect(blockOf(layout, "B1").y).toBeGreaterThan(blockOf(layout, "B0").y + blockOf(layout, "B0").height);
  });

  it("gives a block with no nodes the height of a block with one", () => {
    const layout = layoutOf(EMPTY_BLOCK);

    expect(blockOf(layout, "B1").height).toBe(blockOf(layout, "B0").height);
    expect(blockOf(layout, "B1").firstLine.y).toBeGreaterThan(blockOf(layout, "B1").y);
  });

  it("widens the canvas to hold the lane a climbing edge is routed through", () => {
    const layout = layoutOf(LOOP);
    const lane = Math.max(...flatten(edgeOf(layout, "B2", "B1").trail).map((point) => point.x));

    expect(layout.width).toBeGreaterThan(lane);
  });
});

describe("routing control flow between blocks", () => {
  it("runs an edge straight down when both blocks sit in the same column", () => {
    const layout = layoutOf(LOOP);
    const drawn = flatten(edgeOf(layout, "B0", "B1").trail);

    expect(new Set(drawn.map((point) => point.x)).size).toBe(1);
  });

  it("stops the stroke one arrow head short of the border it points at", () => {
    const layout = layoutOf(LOOP);

    expect(endOf(edgeOf(layout, "B1", "B3").trail).y).toBe(blockOf(layout, "B3").y - ARROW_LENGTH);
    expect(endOf(edgeOf(layout, "B2", "B1").trail).y).toBe(
      blockOf(layout, "B1").y + blockOf(layout, "B1").height + ARROW_LENGTH,
    );
  });

  it("approaches square to the border for the whole length of the arrow head", () => {
    const layout = layoutOf(LOOP);
    for (const [from, to] of [
      ["B1", "B3"],
      ["B2", "B1"],
    ]) {
      const path = edgeOf(layout, from!, to!).trail;

      expect(arrowBaseOf(path).x).toBeCloseTo(endOf(path).x, 6);
    }
  });

  it("keeps the sideways travel in the lane between the two rows", () => {
    const layout = layoutOf(LOOP);
    const source = blockOf(layout, "B1");
    const target = blockOf(layout, "B3");

    for (const point of flatten(edgeOf(layout, "B1", "B3").trail)) {
      expect(point.y).toBeGreaterThanOrEqual(source.y + source.height);
      expect(point.y).toBeLessThanOrEqual(target.y);
    }
  });

  it("never doubles back on itself while rounding a corner", () => {
    const layout = layoutOf(MERGE);
    const drawn = flatten(edgeOf(layout, "B4", "B5").trail);

    for (let at = 1; at < drawn.length; at++) {
      expect(drawn[at]!.y).toBeGreaterThanOrEqual(drawn[at - 1]!.y - 1e-9);
    }
  });

  it("sends an edge that climbs the page around the right of every row it spans", () => {
    const layout = layoutOf(MERGE);
    const spanned = layout.rows.slice(0, blockOf(layout, "B5").row + 1);
    const lane = Math.max(...flatten(edgeOf(layout, "B5", "B0").trail).map((point) => point.x));

    for (const row of spanned) expect(lane).toBeGreaterThan(row.right);
  });

  it("gives every edge arriving at a block its own point on the border", () => {
    const layout = layoutOf(MERGE);
    const arrivals = ["B1", "B2", "B3", "B4"].map((from) => endOf(edgeOf(layout, from, "B5").trail).x);

    expect(new Set(arrivals).size).toBe(arrivals.length);
  });

  it("keeps an arriving back edge off the points the target's own edges leave from", () => {
    const layout = layoutOf(LOOP);
    const arrival = endOf(edgeOf(layout, "B2", "B1").trail).x;
    const departures = ["B2", "B3"].map((to) => flatten(edgeOf(layout, "B1", to).trail)[0]!.x);

    expect(departures).not.toContain(arrival);
  });

  it("holds a same-row edge in the band below that row rather than crossing it", () => {
    const layout = layoutOf(SIBLINGS);
    const source = blockOf(layout, "B1");
    const target = blockOf(layout, "B2");
    const floor = Math.min(source.y + source.height, target.y + target.height);

    for (const point of flatten(edgeOf(layout, "B1", "B2").trail)) {
      expect(point.y).toBeGreaterThanOrEqual(floor);
    }
    expect(endOf(edgeOf(layout, "B1", "B2").trail).y).toBe(target.y + target.height + ARROW_LENGTH);
  });

  it("draws a block that jumps to itself as a loop below it, not as a point", () => {
    const layout = layoutOf(SELF);
    const block = blockOf(layout, "B0");
    const drawn = flatten(layout.edges[0]!.trail);

    expect(layout.edges).toHaveLength(1);
    expect(drawn[0]!.x).not.toBe(endOf(layout.edges[0]!.trail).x);
    expect(Math.max(...drawn.map((point) => point.y))).toBeGreaterThan(block.y + block.height);
  });

  it("hands the arrow head a straight run that reaches back into the trail it ends", () => {
    const layout = layoutOf(MERGE);

    for (const edge of layout.edges) {
      const head = endOf(edge.trail);
      const base = startOf(edge.neck);

      expect(endOf(edge.neck)).toEqual(head);
      expect(Math.hypot(head.x - base.x, head.y - base.y)).toBeGreaterThanOrEqual(ARROW_LENGTH);
      expect(headingOf(base, head).x).toBeCloseTo(headingOf(arrowBaseOf(edge.trail), head).x, 6);
      expect(headingOf(base, head).y).toBeCloseTo(headingOf(arrowBaseOf(edge.trail), head).y, 6);
    }
  });

  it("marks the edges that climb the page apart from the ones that descend", () => {
    const layout = layoutOf(LOOP);

    expect(edgeOf(layout, "B2", "B1").kind).toBe("back");
    expect(edgeOf(layout, "B1", "B3").kind).toBe("forward");
    expect(arrowMarkerId("back")).not.toBe(arrowMarkerId("forward"));
  });
});

describe("routing the values that feed a node", () => {
  it("draws one edge per input and keeps a repeated input from colliding", () => {
    const layout = layoutOf(REPEATED);
    const model = parseGraphText(REPEATED)!;
    const edges = dataEdgesInto(layout, nodeByKey(model, "v1")!);

    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((edge) => edge.key)).size).toBe(2);
  });

  it("arrives at the consumer's left border square to it", () => {
    const layout = layoutOf(REPEATED);
    const model = parseGraphText(REPEATED)!;
    const [edge] = dataEdgesInto(layout, nodeByKey(model, "v1")!);
    const consumer = layout.anchorOf.get("v1")!;

    expect(endOf(edge!.trail).x).toBeCloseTo(consumer.x - ARROW_LENGTH, 6);
    expect(arrowBaseOf(edge!.trail).y).toBeCloseTo(endOf(edge!.trail).y, 6);
  });

  it("gives the two edges of a repeated input lanes of their own to travel in", () => {
    const layout = layoutOf(REPEATED);
    const model = parseGraphText(REPEATED)!;
    const lanes = dataEdgesInto(layout, nodeByKey(model, "v1")!).map((edge) =>
      Math.min(...flatten(edge.trail).map((point) => point.x)),
    );

    expect(new Set(lanes).size).toBe(lanes.length);
  });

  it("carries the arrow head on the straight run the trail ends with", () => {
    const layout = layoutOf(REPEATED);
    const model = parseGraphText(REPEATED)!;

    for (const edge of dataEdgesInto(layout, nodeByKey(model, "v1")!)) {
      expect(endOf(edge.neck)).toEqual(endOf(edge.trail));
      expect(startOf(edge.neck).y).toBeCloseTo(endOf(edge.trail).y, 6);
      expect(startOf(edge.neck).x).toBeLessThan(endOf(edge.trail).x);
    }
  });

  it("comes in behind the arrow head rather than side-on to it", () => {
    const layout = layoutOf(REPEATED);
    const model = parseGraphText(REPEATED)!;

    for (const edge of dataEdgesInto(layout, nodeByKey(model, "v1")!)) {
      const head = endOf(edge.trail);
      const heading = headingOf(startOf(edge.neck), head);
      const neck = Math.hypot(head.x - startOf(edge.neck).x, head.y - startOf(edge.neck).y);
      const entry = travelBack(edge.trail, neck * 2);
      const along = (head.x - entry.x) * heading.x + (head.y - entry.y) * heading.y;
      const across = (head.x - entry.x) * -heading.y + (head.y - entry.y) * heading.x;

      expect(Math.abs(along)).toBeGreaterThan(Math.abs(across));
    }
  });

  it("loops an input that feeds itself off its own line instead of flattening onto it", () => {
    const layout = layoutOf(SELF_PHI);
    const model = parseGraphText(SELF_PHI)!;
    const anchor = layout.anchorOf.get("v2")!;
    const self = dataEdgesInto(layout, nodeByKey(model, "v2")!).find((edge) => edge.key.endsWith("-v2"))!;

    expect(Math.max(...flatten(self.trail).map((point) => anchor.y - point.y))).toBeGreaterThan(ARROW_WIDTH);
    expect(endOf(self.trail)).toEqual(endOf(self.neck));
  });

  it("answers nothing for inputs the layout never placed", () => {
    const layout = layoutOf(LOOP);
    const model = parseGraphText(LOOP)!;

    expect(dataEdgesInto(layout, nodeByKey(model, "v0")!)).toEqual([]);
    expect(dataEdgesInto(layout, nodeByKey(model, "v3")!)).toEqual([]);
  });
});
