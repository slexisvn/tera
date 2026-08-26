import type { ShapeEdge } from "../types/stage";

export type ShapeNode = {
  readonly id: number;
  readonly property: string | null;
  readonly kind: "add" | "delete" | null;
  readonly properties: number | null;
  readonly hits: number;
  readonly children: readonly ShapeNode[];
};

type Arrow = {
  readonly to: number;
  readonly property: string;
  readonly kind: "add" | "delete";
  properties: number | null;
  hits: number;
};

function arrowsOf(edges: readonly ShapeEdge[]): Map<number, Arrow[]> {
  const arrows = new Map<number, Arrow[]>();
  for (const edge of edges) {
    const bucket = arrows.get(edge.from) ?? [];
    const seen = bucket.find(
      (arrow) => arrow.to === edge.to && arrow.property === edge.property && arrow.kind === edge.kind,
    );
    if (seen === undefined) {
      bucket.push({
        to: edge.to,
        property: edge.property,
        kind: edge.kind,
        properties: edge.properties,
        hits: 1,
      });
    } else {
      seen.hits++;
      if (seen.properties === null) seen.properties = edge.properties;
    }
    arrows.set(edge.from, bucket);
  }
  return arrows;
}

export function shapeForest(edges: readonly ShapeEdge[]): readonly ShapeNode[] {
  if (edges.length === 0) return [];
  const arrows = arrowsOf(edges);
  const reached = new Set(edges.map((edge) => edge.to));
  const roots = [...new Set(edges.map((edge) => edge.from))].filter((id) => !reached.has(id));

  const build = (id: number, arrow: Arrow | null, open: ReadonlySet<number>): ShapeNode => {
    const walking = new Set(open).add(id);
    return {
      id,
      property: arrow === null ? null : arrow.property,
      kind: arrow === null ? null : arrow.kind,
      properties: arrow === null ? null : arrow.properties,
      hits: arrow === null ? 0 : arrow.hits,
      children: (arrows.get(id) ?? [])
        .filter((next) => !walking.has(next.to))
        .map((next) => build(next.to, next, walking)),
    };
  };

  return roots.sort((left, right) => left - right).map((id) => build(id, null, new Set()));
}

export function countShapes(forest: readonly ShapeNode[]): number {
  return forest.reduce((total, node) => total + 1 + countShapes(node.children), 0);
}

export function deepestShape(forest: readonly ShapeNode[]): number {
  return forest.reduce((deepest, node) => Math.max(deepest, 1 + deepestShape(node.children)), 0);
}
