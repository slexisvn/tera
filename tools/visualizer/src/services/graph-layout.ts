import { layerBlocks, type IrBlock, type IrGraphModel, type IrNode } from "./ir-graph";

export const ARROW_KINDS = ["forward", "back", "data"] as const;

export type ArrowKind = (typeof ARROW_KINDS)[number];

export type ControlKind = Exclude<ArrowKind, "data">;

export function arrowMarkerId(kind: ArrowKind): string {
  return `graph-arrow-${kind}`;
}

export type Anchor = { readonly x: number; readonly y: number };

export type PlacedNode = {
  readonly node: IrNode;
  readonly anchor: Anchor;
  readonly text: Anchor;
};

export type PlacedBlock = {
  readonly block: IrBlock;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly label: Anchor;
  readonly firstLine: Anchor;
  readonly nodes: readonly PlacedNode[];
};

export type PlacedRow = { readonly bottom: number; readonly right: number };

export type RoutedEdge = {
  readonly key: string;
  readonly kind: ArrowKind;
  readonly path: string;
};

export type GraphLayout = {
  readonly blocks: readonly PlacedBlock[];
  readonly rows: readonly PlacedRow[];
  readonly edges: readonly RoutedEdge[];
  readonly anchorOf: ReadonlyMap<string, Anchor>;
  readonly width: number;
  readonly height: number;
};

const BLOCK_WIDTH = 260;
const BLOCK_RADIUS = 8;
const ROW_GAP = 46;
const COLUMN_GAP = 32;
const HEADER_HEIGHT = 26;
const NODE_HEIGHT = 17;
const FOOT_HEIGHT = 8;
const LABEL_INSET = 10;
const LABEL_BASELINE = 17;
const NODE_INSET = 12;
const NODE_BASELINE = HEADER_HEIGHT + 12;
const ANCHOR_RISE = 4;
const PADDING = 24;
const CORNER = 10;
const SIDE_BULGE = 30;

export const ARROW_LENGTH = 9;
export const ARROW_WIDTH = 7;

const DATA_LANE = ARROW_LENGTH * 3;

const LANE_SHARE: Readonly<Record<ControlKind, number>> = { forward: 0.3, back: 0.72 };

function heightOf(block: IrBlock): number {
  return HEADER_HEIGHT + Math.max(1, block.nodes.length) * NODE_HEIGHT + FOOT_HEIGHT;
}

function sameAnchor(one: Anchor, other: Anchor): boolean {
  return one.x === other.x && one.y === other.y;
}

function trim(corner: Anchor, toward: Anchor): Anchor {
  const dx = toward.x - corner.x;
  const dy = toward.y - corner.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return corner;
  const reach = Math.min(CORNER, length / 2);
  return { x: corner.x + (dx / length) * reach, y: corner.y + (dy / length) * reach };
}

function orthogonal(route: readonly Anchor[]): string {
  const points = route.filter((point, at) => at === 0 || !sameAnchor(point, route[at - 1]!));
  if (points.length < 2) return "";
  const parts = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let at = 1; at < points.length - 1; at++) {
    const corner = points[at]!;
    const into = trim(corner, points[at - 1]!);
    const away = trim(corner, points[at + 1]!);
    parts.push(`L ${into.x} ${into.y}`, `Q ${corner.x} ${corner.y}, ${away.x} ${away.y}`);
  }
  const last = points[points.length - 1]!;
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

function laneBelow(rows: readonly PlacedRow[], row: number, kind: ControlKind): number {
  return rows[row]!.bottom + ROW_GAP * LANE_SHARE[kind];
}

type Border = "top" | "bottom";

type EdgePlan = {
  readonly key: string;
  readonly kind: ControlKind;
  readonly from: PlacedBlock;
  readonly to: PlacedBlock;
};

function entryBorderOf(plan: EdgePlan): Border {
  return plan.kind === "forward" ? "top" : "bottom";
}

function borderKey(block: PlacedBlock, border: Border): string {
  return `${block.block.label}:${border}`;
}

function portOn(block: PlacedBlock, border: Border, slot: number, sharing: number): Anchor {
  return {
    x: block.x + (block.width * (slot + 1)) / (sharing + 1),
    y: border === "top" ? block.y : block.y + block.height,
  };
}

function portsOf(plans: readonly EdgePlan[]): ReadonlyMap<string, Anchor> {
  const sharing = new Map<string, number>();
  const count = (border: string): void => {
    sharing.set(border, (sharing.get(border) ?? 0) + 1);
  };
  for (const plan of plans) {
    count(borderKey(plan.from, "bottom"));
    count(borderKey(plan.to, entryBorderOf(plan)));
  }

  const taken = new Map<string, number>();
  const nextSlot = (border: string): number => {
    const slot = taken.get(border) ?? 0;
    taken.set(border, slot + 1);
    return slot;
  };

  const ports = new Map<string, Anchor>();
  for (const plan of plans) {
    const exit = borderKey(plan.from, "bottom");
    const entry = borderKey(plan.to, entryBorderOf(plan));
    ports.set(`${plan.key}:exit`, portOn(plan.from, "bottom", nextSlot(exit), sharing.get(exit)!));
    ports.set(
      `${plan.key}:entry`,
      portOn(plan.to, entryBorderOf(plan), nextSlot(entry), sharing.get(entry)!),
    );
  }
  return ports;
}

type Route = { readonly corners: readonly Anchor[]; readonly reach: number };

function routeOf(plan: EdgePlan, ports: ReadonlyMap<string, Anchor>, rows: readonly PlacedRow[]): Route {
  const exit = ports.get(`${plan.key}:exit`)!;
  const entry = ports.get(`${plan.key}:entry`)!;
  const end = {
    x: entry.x,
    y: plan.kind === "forward" ? entry.y - ARROW_LENGTH : entry.y + ARROW_LENGTH,
  };
  const reach = Math.max(exit.x, entry.x);

  if (plan.kind === "forward" && exit.x === entry.x) return { corners: [exit, end], reach };

  if (plan.to.row >= plan.from.row) {
    const lane = laneBelow(rows, plan.from.row, plan.kind);
    return { corners: [exit, { x: exit.x, y: lane }, { x: entry.x, y: lane }, end], reach };
  }

  const fromLane = laneBelow(rows, plan.from.row, plan.kind);
  const toLane = laneBelow(rows, plan.to.row, plan.kind);
  let rightmost = 0;
  for (let row = plan.to.row; row <= plan.from.row; row++) rightmost = Math.max(rightmost, rows[row]!.right);
  const side = rightmost + SIDE_BULGE;
  return {
    reach: side,
    corners: [
      exit,
      { x: exit.x, y: fromLane },
      { x: side, y: fromLane },
      { x: side, y: toLane },
      { x: entry.x, y: toLane },
      end,
    ],
  };
}

function dataPath(from: Anchor, to: Anchor): string {
  const lane = Math.min(from.x, to.x) - DATA_LANE;
  const tip = to.x - ARROW_LENGTH;
  const approach = tip - ARROW_LENGTH;
  return `M ${from.x} ${from.y} C ${lane} ${from.y}, ${lane} ${to.y}, ${approach} ${to.y} L ${tip} ${to.y}`;
}

function placeBlock(block: IrBlock, row: number, x: number, y: number): PlacedBlock {
  const lineAt = (at: number): number => y + NODE_BASELINE + at * NODE_HEIGHT;
  return {
    block,
    row,
    x,
    y,
    width: BLOCK_WIDTH,
    height: heightOf(block),
    radius: BLOCK_RADIUS,
    label: { x: x + LABEL_INSET, y: y + LABEL_BASELINE },
    firstLine: { x: x + NODE_INSET, y: lineAt(0) },
    nodes: block.nodes.map((node, at) => ({
      node,
      anchor: { x, y: lineAt(at) - ANCHOR_RISE },
      text: { x: x + NODE_INSET, y: lineAt(at) },
    })),
  };
}

export function layoutGraph(model: IrGraphModel): GraphLayout {
  const blocks: PlacedBlock[] = [];
  const rows: PlacedRow[] = [];
  let y = PADDING;

  layerBlocks(model).forEach((layer, row) => {
    let x = PADDING;
    let tallest = 0;
    for (const block of layer) {
      const placed = placeBlock(block, row, x, y);
      blocks.push(placed);
      x += placed.width + COLUMN_GAP;
      tallest = Math.max(tallest, placed.height);
    }
    rows.push({ bottom: y + tallest, right: x - COLUMN_GAP });
    y += tallest + ROW_GAP;
  });

  const byLabel = new Map(blocks.map((placed) => [placed.block.label, placed]));
  const plans: EdgePlan[] = [];
  for (const from of blocks) {
    from.block.successors.forEach((label, at) => {
      const to = byLabel.get(label);
      if (to === undefined) return;
      plans.push({
        key: `${from.block.label}-${at}-${label}`,
        kind: to.row > from.row ? "forward" : "back",
        from,
        to,
      });
    });
  }

  const ports = portsOf(plans);
  const edges: RoutedEdge[] = [];
  let reach = rows.reduce((widest, row) => Math.max(widest, row.right), PADDING);
  for (const plan of plans) {
    const route = routeOf(plan, ports, rows);
    reach = Math.max(reach, route.reach);
    edges.push({ key: plan.key, kind: plan.kind, path: orthogonal(route.corners) });
  }

  const anchorOf = new Map<string, Anchor>();
  for (const placed of blocks) {
    for (const { node, anchor } of placed.nodes) anchorOf.set(node.key, anchor);
  }

  return { blocks, rows, edges, anchorOf, width: reach + PADDING, height: y + PADDING };
}

export function dataEdgesInto(layout: GraphLayout, target: IrNode): readonly RoutedEdge[] {
  const to = layout.anchorOf.get(target.key);
  if (to === undefined) return [];
  return target.inputs.flatMap((input, at) => {
    const from = layout.anchorOf.get(input);
    if (from === undefined) return [];
    return [{ key: `data-${at}-${input}`, kind: "data" as const, path: dataPath(from, to) }];
  });
}
