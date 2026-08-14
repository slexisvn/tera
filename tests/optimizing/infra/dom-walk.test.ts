import { describe, expect, it } from "vitest";
import { walkDominatorTree, type ScopedVisitor } from "../../../src/optimizing/infra/dom-walk.js";

const tree = new Map<string, string[]>([
  ["a", ["b", "c"]],
  ["b", ["d"]],
  ["c", []],
  ["d", []],
]);
const childrenOf = (block: string): readonly string[] => tree.get(block) ?? [];

describe("walkDominatorTree", () => {
  it("visits blocks in pre-order from the root", () => {
    const order: string[] = [];
    const visitor: ScopedVisitor<string, number> = {
      fork: (state) => state,
      visitBlock: (block) => order.push(block),
    };
    walkDominatorTree<string, number>("a", childrenOf, 0, visitor);
    expect(order).toEqual(["a", "b", "d", "c"]);
  });

  it("forks state down each branch so siblings never share mutations", () => {
    const depthOf = new Map<string, number>();
    const visitor: ScopedVisitor<string, number> = {
      fork: (state) => state + 1,
      visitBlock: (block, state) => depthOf.set(block, state),
    };
    walkDominatorTree<string, number>("a", childrenOf, 0, visitor);
    expect(depthOf.get("a")).toBe(0);
    expect(depthOf.get("b")).toBe(1);
    expect(depthOf.get("c")).toBe(1);
    expect(depthOf.get("d")).toBe(2);
  });

  it("visits a leaf root exactly once", () => {
    const order: string[] = [];
    const visitor: ScopedVisitor<string, null> = {
      fork: (state) => state,
      visitBlock: (block) => order.push(block),
    };
    walkDominatorTree<string, null>("c", childrenOf, null, visitor);
    expect(order).toEqual(["c"]);
  });
});
