import { describe, expect, it } from "vitest";
import { countShapes, deepestShape, shapeForest } from "../src/services/shape-tree";
import type { ShapeEdge } from "../src/types/stage";

function add(from: number, to: number, property: string, properties: number | null = null): ShapeEdge {
  return { kind: "add", from, to, property, properties };
}

describe("building the hidden class transition tree", () => {
  it("finds nothing to draw when the run recorded no transition", () => {
    expect(shapeForest([])).toEqual([]);
  });

  it("roots the tree at the shape nothing transitions into", () => {
    const forest = shapeForest([add(1, 2, "x"), add(2, 3, "y")]);

    expect(forest).toHaveLength(1);
    expect(forest[0]!.id).toBe(1);
    expect(forest[0]!.property).toBeNull();
  });

  it("labels each child with the property that created it", () => {
    const forest = shapeForest([add(1, 2, "x", 1), add(2, 3, "y", 2)]);

    const [x] = forest[0]!.children;
    expect(x).toMatchObject({ id: 2, property: "x", kind: "add", properties: 1 });
    expect(x!.children[0]).toMatchObject({ id: 3, property: "y", properties: 2 });
  });

  it("branches when the same shape gains different properties", () => {
    const forest = shapeForest([add(1, 2, "x"), add(1, 3, "y")]);

    expect(forest[0]!.children.map((child) => child.property)).toEqual(["x", "y"]);
  });

  it("counts how many objects walked the same edge instead of repeating it", () => {
    const forest = shapeForest([add(1, 2, "x"), add(1, 2, "x"), add(1, 2, "x")]);

    expect(forest[0]!.children).toHaveLength(1);
    expect(forest[0]!.children[0]!.hits).toBe(3);
  });

  it("keeps a delete transition distinct from an add between the same shapes", () => {
    const forest = shapeForest([add(1, 2, "x"), { kind: "delete", from: 1, to: 2, property: "x", properties: null }]);

    expect(forest[0]!.children.map((child) => child.kind)).toEqual(["add", "delete"]);
  });

  it("stops rather than looping when transitions form a cycle", () => {
    const forest = shapeForest([add(0, 1, "a"), add(1, 2, "x"), add(2, 1, "y")]);

    expect(countShapes(forest)).toBe(3);
    expect(deepestShape(forest)).toBe(3);
  });

  it("reports several roots when the run built unrelated shape chains", () => {
    const forest = shapeForest([add(1, 2, "x"), add(7, 8, "z")]);

    expect(forest.map((root) => root.id)).toEqual([1, 7]);
  });

  it("measures the tree so a reader can see how deep the shapes went", () => {
    const forest = shapeForest([add(1, 2, "x"), add(2, 3, "y"), add(1, 4, "z")]);

    expect(countShapes(forest)).toBe(4);
    expect(deepestShape(forest)).toBe(3);
  });
});
