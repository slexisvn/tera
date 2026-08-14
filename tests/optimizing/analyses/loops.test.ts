import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGBlock,
  CFGFunction,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import { DominatorTree } from "../../../src/optimizing/analyses/dominance.js";
import { Loop, LoopForest } from "../../../src/optimizing/analyses/loops.js";

beforeEach(() => resetIRNodeIds());

function forestFor(graph: CFGFunction): LoopForest {
  return new LoopForest(graph, new DominatorTree(graph));
}

function loopWithHeader(forest: LoopForest, header: CFGBlock): Loop {
  const loop = [...forest.loops()].find((candidate) => candidate.header === header);
  if (!loop) throw new Error(`missing loop for B${header.id}`);
  return loop;
}

function expectBlocks(
  actual: Iterable<CFGBlock>,
  expected: readonly CFGBlock[],
): void {
  expect(new Set([...actual].map((block) => block.id))).toEqual(
    new Set(expected.map((block) => block.id)),
  );
}

function singleLoopGraph() {
  const graph = new CFGFunction("single");
  const preheader = graph.addBlock();
  const header = graph.addBlock();
  const body = graph.addBlock();
  const exit = graph.addBlock();
  link(preheader, header);
  link(header, body);
  link(body, header);
  link(header, exit);
  return { graph, preheader, header, body, exit };
}

describe("LoopForest", () => {
  it("builds a single natural loop", () => {
    const { graph, preheader, header, body, exit } = singleLoopGraph();
    const forest = forestFor(graph);
    const loops = [...forest.loops()];

    expect(loops).toHaveLength(1);
    expect(loops[0].header).toBe(header);
    expect(loops[0].latches).toEqual([body]);
    expectBlocks(loops[0].blocks, [header, body]);
    expect(loops[0].preheader).toBe(preheader);
    expect(loops[0].exitBlocks).toEqual([exit]);
    expect(forest.isHeader(header)).toBe(true);
    expect(forest.loopOf(body)).toBe(loops[0]);
    expect(forest.depthOf(preheader)).toBe(0);
  });

  it("maps nested loops to increasing depth", () => {
    const graph = new CFGFunction("nested");
    const preheader = graph.addBlock();
    const outerHeader = graph.addBlock();
    const innerHeader = graph.addBlock();
    const innerBody = graph.addBlock();
    const outerLatch = graph.addBlock();
    const exit = graph.addBlock();
    link(preheader, outerHeader);
    link(outerHeader, innerHeader);
    link(innerHeader, innerBody);
    link(innerBody, innerHeader);
    link(innerHeader, outerLatch);
    link(outerLatch, outerHeader);
    link(outerHeader, exit);

    const forest = forestFor(graph);
    const outer = loopWithHeader(forest, outerHeader);
    const inner = loopWithHeader(forest, innerHeader);

    expect(forest.roots).toEqual([outer]);
    expect(outer.children).toEqual([inner]);
    expect(inner.parent).toBe(outer);
    expect(outer.depth).toBe(1);
    expect(inner.depth).toBe(2);
    expect(forest.loopOf(innerBody)).toBe(inner);
    expect(forest.loopOf(outerLatch)).toBe(outer);
    expectBlocks(outer.blocks, [outerHeader, innerHeader, innerBody, outerLatch]);
  });

  it("merges two latches into one loop", () => {
    const graph = new CFGFunction("multi-latch");
    const preheader = graph.addBlock();
    const header = graph.addBlock();
    const leftLatch = graph.addBlock();
    const rightLatch = graph.addBlock();
    const exit = graph.addBlock();
    link(preheader, header);
    link(header, leftLatch);
    link(header, rightLatch);
    link(leftLatch, header);
    link(rightLatch, header);
    link(header, exit);

    const loop = loopWithHeader(forestFor(graph), header);

    expect(loop.latches).toEqual([leftLatch, rightLatch]);
    expectBlocks(loop.blocks, [header, leftLatch, rightLatch]);
  });

  it("keeps sibling loops at root depth", () => {
    const graph = new CFGFunction("siblings");
    const entry = graph.addBlock();
    const firstHeader = graph.addBlock();
    const firstBody = graph.addBlock();
    const between = graph.addBlock();
    const secondHeader = graph.addBlock();
    const secondBody = graph.addBlock();
    const exit = graph.addBlock();
    link(entry, firstHeader);
    link(firstHeader, firstBody);
    link(firstBody, firstHeader);
    link(firstHeader, between);
    link(between, secondHeader);
    link(secondHeader, secondBody);
    link(secondBody, secondHeader);
    link(secondHeader, exit);

    const forest = forestFor(graph);
    const first = loopWithHeader(forest, firstHeader);
    const second = loopWithHeader(forest, secondHeader);

    expect(forest.roots).toEqual([first, second]);
    expect(first.parent).toBeNull();
    expect(second.parent).toBeNull();
    expect(first.depth).toBe(1);
    expect(second.depth).toBe(1);
  });

  it("derives exiting blocks, exit blocks, and preheader", () => {
    const graph = new CFGFunction("boundaries");
    const preheader = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const firstExit = graph.addBlock();
    const secondExit = graph.addBlock();
    link(preheader, header);
    link(header, body);
    link(body, header);
    link(header, firstExit);
    link(body, secondExit);

    const loop = loopWithHeader(forestFor(graph), header);

    expect(loop.preheader).toBe(preheader);
    expectBlocks(loop.exitingBlocks, [header, body]);
    expectBlocks(loop.exitBlocks, [firstExit, secondExit]);
  });

  it("excludes unreachable blocks from loops", () => {
    const { graph, header, body } = singleLoopGraph();
    const orphan = graph.addBlock();
    link(orphan, orphan);

    const forest = forestFor(graph);
    const loop = loopWithHeader(forest, header);

    expect(loop.blocks.has(body)).toBe(true);
    expect(loop.blocks.has(orphan)).toBe(false);
    expect(forest.loopOf(orphan)).toBeNull();
  });

  it("marks irreducible two-entry regions", () => {
    const graph = new CFGFunction("irreducible");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();
    const exit = graph.addBlock();
    link(entry, left);
    link(entry, right);
    link(left, right);
    link(right, left);
    link(left, exit);
    link(right, exit);

    const forest = forestFor(graph);

    expect(forest.irreducible).toBe(true);
    expect([...forest.loops()]).toHaveLength(0);
  });
});
