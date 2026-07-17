import { describe, it, expect, beforeEach } from "vitest";
import {
  deadCodeElimination,
  eliminateUnreachableBlocks,
} from "../../src/optimizing/passes/dce.js";
import {
  CFGFunction,
  irConstant,
  irInt32Add,
  irReturn,
  irJump,
  irBranch,
  irStoreField,
  irLoadField,
  irNewObject,
  IR_CONSTANT,
  IR_INT32_ADD,
  IR_RETURN,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

function makeGraph() {
  const graph = new CFGFunction("test");
  const block = graph.addBlock();
  return { graph, block };
}

describe("deadCodeElimination", () => {
  it("removes unused pure computation", () => {
    const { graph, block } = makeGraph();
    const a = irConstant(1);
    const b = irConstant(2);
    block.addNode(a);
    block.addNode(b);
    const dead = irInt32Add(a, b);
    block.addNode(dead);
    const c = irConstant(42);
    block.addNode(c);
    const ret = irReturn(c);
    block.addNode(ret);
    const count = deadCodeElimination(graph);
    expect(count).toBeGreaterThan(0);
    expect(block.nodes.map(n => n.type)).not.toContain(IR_INT32_ADD);
  });

  it("keeps used computation", () => {
    const { graph, block } = makeGraph();
    const a = irConstant(1);
    const b = irConstant(2);
    block.addNode(a);
    block.addNode(b);
    const add = irInt32Add(a, b);
    block.addNode(add);
    const ret = irReturn(add);
    block.addNode(ret);
    const count = deadCodeElimination(graph);
    expect(block.nodes).toContain(add);
  });

  it("keeps side-effecting nodes even without uses", () => {
    const { graph, block } = makeGraph();
    const obj = irConstant({});
    block.addNode(obj);
    const val = irConstant(1);
    block.addNode(val);
    const store = irStoreField(obj, 0, val);
    block.addNode(store);
    const ret = irReturn(irConstant(0));
    block.addNode(ret);
    const count = deadCodeElimination(graph);
    expect(block.nodes).toContain(store);
  });

  it("removes chains of dead nodes", () => {
    const { graph, block } = makeGraph();
    const a = irConstant(1);
    const b = irConstant(2);
    block.addNode(a);
    block.addNode(b);
    const add1 = irInt32Add(a, b);
    block.addNode(add1);
    const add2 = irInt32Add(add1, irConstant(3));
    block.addNode(add2);
    const ret = irReturn(irConstant(0));
    block.addNode(ret);
    const count = deadCodeElimination(graph);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("preserves block params", () => {
    const { graph, block } = makeGraph();
    const b1 = graph.addBlock();
    const param = b1.addParam([]);
    const jmp = irJump(b1);
    block.addNode(jmp);
    block.addSuccessor(b1);
    const ret = irReturn(irConstant(0));
    b1.addNode(ret);
    deadCodeElimination(graph);
    expect(b1.params).toContain(param);
  });
});

describe("eliminateUnreachableBlocks", () => {
  it("removes blocks not reachable from entry", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    b0.addSuccessor(b1);
    const jmp = irJump(b1);
    b0.addNode(jmp);
    const ret = irReturn(irConstant(0));
    b1.addNode(ret);
    b2.addNode(irReturn(irConstant(1)));
    const removed = eliminateUnreachableBlocks(graph);
    expect(removed).toBe(1);
    expect(graph.blocks).toHaveLength(2);
    expect(graph.blocks.map(b => b.id)).not.toContain(b2.id);
  });

  it("returns 0 when all blocks are reachable", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));
    b1.addNode(irReturn(irConstant(0)));
    const removed = eliminateUnreachableBlocks(graph);
    expect(removed).toBe(0);
  });

  it("disconnects unreachable block from successors", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    const b3 = graph.addBlock();
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));
    b1.addNode(irReturn(irConstant(0)));
    b2.addSuccessor(b3);
    b2.addNode(irJump(b3));
    b3.addNode(irReturn(irConstant(1)));
    eliminateUnreachableBlocks(graph);
    expect(graph.blocks).toHaveLength(2);
  });

  it("returns 0 for graph without entry", () => {
    const graph = new CFGFunction("test");
    const removed = eliminateUnreachableBlocks(graph);
    expect(removed).toBe(0);
  });
});
