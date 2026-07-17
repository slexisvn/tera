import { describe, it, expect, beforeEach } from "vitest";
import {
  computeDominators,
  buildDominatorTree,
  dominates,
} from "../../src/optimizing/passes/dominators.js";
import {
  CFGFunction,
  irConstant,
  irReturn,
  irJump,
  irBranch,
  irInt32Compare,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

function makeLinearGraph() {
  const graph = new CFGFunction("linear");
  const b0 = graph.addBlock();
  const b1 = graph.addBlock();
  const b2 = graph.addBlock();
  b0.addSuccessor(b1);
  b1.addSuccessor(b2);
  const jmp0 = irJump(b1);
  b0.addNode(jmp0);
  const jmp1 = irJump(b2);
  b1.addNode(jmp1);
  const ret = irReturn(irConstant(0));
  b2.addNode(ret);
  return { graph, b0, b1, b2 };
}

function makeDiamondGraph() {
  const graph = new CFGFunction("diamond");
  const b0 = graph.addBlock();
  const b1 = graph.addBlock();
  const b2 = graph.addBlock();
  const b3 = graph.addBlock();
  const cond = irConstant(1);
  b0.addNode(cond);
  const br = irBranch(cond, b1, b2);
  b0.addNode(br);
  b0.addSuccessor(b1);
  b0.addSuccessor(b2);
  const jmp1 = irJump(b3);
  b1.addNode(jmp1);
  b1.addSuccessor(b3);
  const jmp2 = irJump(b3);
  b2.addNode(jmp2);
  b2.addSuccessor(b3);
  const ret = irReturn(irConstant(0));
  b3.addNode(ret);
  return { graph, b0, b1, b2, b3 };
}

function makeLoopGraph() {
  const graph = new CFGFunction("loop");
  const b0 = graph.addBlock();
  const b1 = graph.addBlock();
  const b2 = graph.addBlock();
  const b3 = graph.addBlock();
  b0.addNode(irJump(b1));
  b0.addSuccessor(b1);
  const cond = irConstant(1);
  b1.addNode(cond);
  b1.addNode(irBranch(cond, b2, b3));
  b1.addSuccessor(b2);
  b1.addSuccessor(b3);
  b2.addNode(irJump(b1));
  b2.addSuccessor(b1);
  b3.addNode(irReturn(irConstant(0)));
  return { graph, b0, b1, b2, b3 };
}

function makeUnreachableGraph() {
  const graph = new CFGFunction("unreachable");
  const b0 = graph.addBlock();
  const b1 = graph.addBlock();
  const orphan = graph.addBlock();
  b0.addNode(irJump(b1));
  b0.addSuccessor(b1);
  b1.addNode(irReturn(irConstant(0)));
  orphan.addNode(irReturn(irConstant(1)));
  return { graph, b0, b1, orphan };
}

describe("computeDominators", () => {
  it("entry block dominates itself", () => {
    const { graph, b0 } = makeLinearGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, b0, b0)).toBe(true);
  });

  it("every block is dominated by entry in linear chain", () => {
    const { graph, b0, b1, b2 } = makeLinearGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, b0, b1)).toBe(true);
    expect(dominates(dom, b0, b2)).toBe(true);
    expect(dominates(dom, b1, b2)).toBe(true);
  });

  it("in diamond, merge block is dominated by entry but not by branches", () => {
    const { graph, b0, b1, b2, b3 } = makeDiamondGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, b0, b3)).toBe(true);
    expect(dominates(dom, b1, b3)).toBe(false);
    expect(dominates(dom, b2, b3)).toBe(false);
  });

  it("branch blocks are dominated by entry", () => {
    const { graph, b0, b1, b2 } = makeDiamondGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, b0, b1)).toBe(true);
    expect(dominates(dom, b0, b2)).toBe(true);
  });

  it("returns empty map for empty graph", () => {
    const graph = new CFGFunction("empty");
    const dom = computeDominators(graph);
    expect(dom.size).toBe(0);
  });

  it("resolves a loop with a back edge", () => {
    const { graph, b0, b1, b2, b3 } = makeLoopGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, b0, b1)).toBe(true);
    expect(dominates(dom, b1, b2)).toBe(true);
    expect(dominates(dom, b1, b3)).toBe(true);
    expect(dominates(dom, b2, b3)).toBe(false);
    const { idomMap } = buildDominatorTree(graph, dom);
    expect(idomMap.get(b2)).toBe(b1);
    expect(idomMap.get(b3)).toBe(b1);
  });

  it("treats a block unreachable from entry as dominated only by itself", () => {
    const { graph, b0, b1, orphan } = makeUnreachableGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, orphan, orphan)).toBe(true);
    expect(dominates(dom, b0, orphan)).toBe(false);
    expect(dominates(dom, b1, orphan)).toBe(false);
    const { children } = buildDominatorTree(graph, dom);
    expect(children.get(b0)).not.toContain(orphan);
  });
});

describe("buildDominatorTree", () => {
  it("linear chain has correct parent-child relationships", () => {
    const { graph, b0, b1, b2 } = makeLinearGraph();
    const dom = computeDominators(graph);
    const { children, idomMap } = buildDominatorTree(graph, dom);
    expect(children.get(b0)).toContain(b1);
    expect(children.get(b1)).toContain(b2);
    expect(idomMap.get(b1)).toBe(b0);
    expect(idomMap.get(b2)).toBe(b1);
  });

  it("diamond: entry is idom of both branches and merge", () => {
    const { graph, b0, b1, b2, b3 } = makeDiamondGraph();
    const dom = computeDominators(graph);
    const { children, idomMap } = buildDominatorTree(graph, dom);
    expect(children.get(b0)).toContain(b1);
    expect(children.get(b0)).toContain(b2);
    expect(idomMap.get(b3)).toBe(b0);
  });
});

describe("dominates", () => {
  it("entry dominates all blocks", () => {
    const { graph, b0, b1, b2 } = makeLinearGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, b0, b0)).toBe(true);
    expect(dominates(dom, b0, b1)).toBe(true);
    expect(dominates(dom, b0, b2)).toBe(true);
  });

  it("later block does not dominate earlier block", () => {
    const { graph, b0, b1, b2 } = makeLinearGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, b2, b0)).toBe(false);
    expect(dominates(dom, b1, b0)).toBe(false);
  });

  it("branch does not dominate sibling branch in diamond", () => {
    const { graph, b1, b2 } = makeDiamondGraph();
    const dom = computeDominators(graph);
    expect(dominates(dom, b1, b2)).toBe(false);
    expect(dominates(dom, b2, b1)).toBe(false);
  });
});
