import { describe, it, expect, beforeEach } from "vitest";
import { globalValueNumbering } from "../../src/optimizing/passes/gvn.js";
import {
  CFGFunction,
  irConstant,
  irInt32Add,
  irInt32Mul,
  irReturn,
  irJump,
  irStoreField,
  IR_INT32_ADD,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

function makeGraph() {
  const graph = new CFGFunction("test");
  const block = graph.addBlock();
  return { graph, block };
}

describe("globalValueNumbering", () => {
  it("eliminates redundant computation with same inputs", () => {
    const { graph, block } = makeGraph();
    const a = irConstant(1);
    const b = irConstant(2);
    block.addNode(a);
    block.addNode(b);
    const add1 = irInt32Add(a, b);
    block.addNode(add1);
    const add2 = irInt32Add(a, b);
    block.addNode(add2);
    const ret = irReturn(add2);
    block.addNode(ret);
    const count = globalValueNumbering(graph);
    expect(count).toBeGreaterThan(0);
    expect(ret.inputs[0]).toBe(add1);
  });

  it("does not eliminate different operations on same inputs", () => {
    const { graph, block } = makeGraph();
    const a = irConstant(1);
    const b = irConstant(2);
    block.addNode(a);
    block.addNode(b);
    const add = irInt32Add(a, b);
    block.addNode(add);
    const mul = irInt32Mul(a, b);
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    const count = globalValueNumbering(graph);
    expect(count).toBe(0);
  });

  it("handles commutative ops: add(a,b) == add(b,a)", () => {
    const { graph, block } = makeGraph();
    const a = irConstant(3);
    const b = irConstant(4);
    block.addNode(a);
    block.addNode(b);
    const add1 = irInt32Add(a, b);
    block.addNode(add1);
    const add2 = irInt32Add(b, a);
    block.addNode(add2);
    const ret = irReturn(add2);
    block.addNode(ret);
    const count = globalValueNumbering(graph);
    expect(count).toBeGreaterThan(0);
    expect(ret.inputs[0]).toBe(add1);
  });

  it("propagates through dominated blocks", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const a = irConstant(1);
    const b = irConstant(2);
    b0.addNode(a);
    b0.addNode(b);
    const add1 = irInt32Add(a, b);
    b0.addNode(add1);
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));
    const add2 = irInt32Add(a, b);
    b1.addNode(add2);
    const ret = irReturn(add2);
    b1.addNode(ret);
    const count = globalValueNumbering(graph);
    expect(count).toBeGreaterThan(0);
    expect(ret.inputs[0]).toBe(add1);
  });

  it("does not eliminate nodes with side effects", () => {
    const { graph, block } = makeGraph();
    const obj = irConstant({});
    block.addNode(obj);
    const store1 = irStoreField(obj, 0, irConstant(1));
    block.addNode(store1);
    const store2 = irStoreField(obj, 0, irConstant(1));
    block.addNode(store2);
    const ret = irReturn(irConstant(0));
    block.addNode(ret);
    const count = globalValueNumbering(graph);
    expect(count).toBe(0);
  });

  it("returns 0 when nothing to eliminate", () => {
    const { graph, block } = makeGraph();
    const a = irConstant(1);
    const b = irConstant(2);
    block.addNode(a);
    block.addNode(b);
    const add = irInt32Add(a, b);
    block.addNode(add);
    const ret = irReturn(add);
    block.addNode(ret);
    const count = globalValueNumbering(graph);
    expect(count).toBe(0);
  });
});
