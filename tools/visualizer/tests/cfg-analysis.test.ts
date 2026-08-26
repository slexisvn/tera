import { describe, expect, it } from "vitest";
import { dominanceOf, loopForestOf } from "../src/services/cfg-analysis";
import { parseGraphText } from "../src/services/ir-graph";

function model(text: string) {
  const parsed = parseGraphText(text);
  if (parsed === null) throw new Error("the fixture did not parse as a graph");
  return parsed;
}

const DIAMOND = `fn diamond params=1 {
  B0 succs=B1,B2 preds=:
    v1 = Branch v0
  B1 succs=B3 preds=B0:
    v2 = Jump
  B2 succs=B3 preds=B0:
    v3 = Jump
  B3 succs= preds=B1,B2:
    v4 = Return v0
}
`;

const LOOP = `fn counted params=1 {
  B0 succs=B1 preds=:
    v1 = Jump
  B1 loop-header succs=B2,B3 preds=B0,B2:
    v2 = Branch v0
  B2 succs=B1 preds=B1:
    v3 = Jump
  B3 succs= preds=B1:
    v4 = Return v0
}
`;

const NESTED = `fn nested params=1 {
  B0 succs=B1 preds=:
    v1 = Jump
  B1 loop-header succs=B2,B5 preds=B0,B4:
    v2 = Branch v0
  B2 loop-header succs=B3,B4 preds=B1,B3:
    v3 = Branch v0
  B3 succs=B2 preds=B2:
    v4 = Jump
  B4 succs=B1 preds=B2:
    v5 = Jump
  B5 succs= preds=B1:
    v6 = Return v0
}
`;

describe("dominance over a printed graph", () => {
  it("makes the entry the root, dominating everything reachable", () => {
    const dominance = dominanceOf(model(DIAMOND));

    expect(dominance.idom.get("B0")).toBeNull();
    expect(dominance.dominates("B0", "B3")).toBe(true);
  });

  it("hangs a merge off the branch, not off either arm", () => {
    const dominance = dominanceOf(model(DIAMOND));

    expect(dominance.idom.get("B3")).toBe("B0");
    expect(dominance.dominates("B1", "B3")).toBe(false);
    expect(dominance.dominates("B2", "B3")).toBe(false);
  });

  it("lists the blocks a node immediately dominates as its children", () => {
    const dominance = dominanceOf(model(DIAMOND));

    expect([...dominance.childrenOf("B0")].sort()).toEqual(["B1", "B2", "B3"]);
    expect(dominance.childrenOf("B1")).toEqual([]);
  });

  it("treats a block as dominating itself", () => {
    expect(dominanceOf(model(DIAMOND)).dominates("B1", "B1")).toBe(true);
  });
});

describe("the loop forest a pass would see", () => {
  it("finds the loop whose back edge returns to a block that dominates it", () => {
    const graph = model(LOOP);
    const [loop] = loopForestOf(graph, dominanceOf(graph));

    expect(loop?.header).toBe("B1");
    expect(loop?.latches).toEqual(["B2"]);
    expect(loop?.blocks).toEqual(["B1", "B2"]);
    expect(loop?.depth).toBe(0);
  });

  it("leaves the exit block outside the loop body", () => {
    const graph = model(LOOP);
    const [loop] = loopForestOf(graph, dominanceOf(graph));

    expect(loop?.blocks).not.toContain("B3");
  });

  it("nests an inner loop under the outer one it sits inside", () => {
    const graph = model(NESTED);
    const forest = loopForestOf(graph, dominanceOf(graph));

    expect(forest).toHaveLength(1);
    expect(forest[0]!.header).toBe("B1");
    expect(forest[0]!.children.map((child) => child.header)).toEqual(["B2"]);
    expect(forest[0]!.children[0]!.depth).toBe(1);
  });

  it("finds no loop in a graph with no back edge", () => {
    const graph = model(DIAMOND);

    expect(loopForestOf(graph, dominanceOf(graph))).toEqual([]);
  });
});
