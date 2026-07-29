import { describe, it, expect, beforeEach } from "vitest";
import {
  eliminateRedundantChecks,
  rangeAnalysisAndBoundsCheckElimination,
} from "../../src/optimizing/passes/checks.js";
import {
  CFGFunction,
  irConstant,
  irCheckMap,
  irCheckSmi,
  irCheckNumber,
  irCheckElementsKind,
  irCheckBounds,
  irInt32Add,
  irInt32Sub,
  irInt32Compare,
  irReturn,
  irJump,
  irBranch,
  irStoreField,
  irLoadArrayLength,
  IR_CHECK_MAP,
  IR_CHECK_SMI,
  IR_CHECK_BOUNDS,
  IR_JUMP,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

describe("eliminateRedundantChecks", () => {
  it("removes duplicate CheckMap on same object with same map", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = graph.addParameter(0);
    const check1 = irCheckMap(obj, 42);
    block.addNode(check1);
    const check2 = irCheckMap(obj, 42);
    block.addNode(check2);
    const ret = irReturn(check2);
    block.addNode(ret);
    const count = eliminateRedundantChecks(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(check1);
  });

  it("does not remove CheckMap with different map ids", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = graph.addParameter(0);
    const check1 = irCheckMap(obj, 42);
    block.addNode(check1);
    const check2 = irCheckMap(obj, 99);
    block.addNode(check2);
    const ret = irReturn(check2);
    block.addNode(ret);
    const count = eliminateRedundantChecks(graph);
    expect(count).toBe(0);
  });

  it("removes duplicate CheckSmi on same value", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const val = graph.addParameter(0);
    const check1 = irCheckSmi(val);
    block.addNode(check1);
    const check2 = irCheckSmi(val);
    block.addNode(check2);
    const ret = irReturn(check2);
    block.addNode(ret);
    const count = eliminateRedundantChecks(graph);
    expect(count).toBe(1);
  });

  it("removes duplicate CheckNumber", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const val = graph.addParameter(0);
    const check1 = irCheckNumber(val);
    block.addNode(check1);
    const check2 = irCheckNumber(val);
    block.addNode(check2);
    const ret = irReturn(check2);
    block.addNode(ret);
    const count = eliminateRedundantChecks(graph);
    expect(count).toBe(1);
  });

  it("propagates checks through dominator tree", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const val = graph.addParameter(0);
    const check1 = irCheckSmi(val);
    b0.addNode(check1);
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));
    const check2 = irCheckSmi(val);
    b1.addNode(check2);
    const ret = irReturn(check2);
    b1.addNode(ret);
    const count = eliminateRedundantChecks(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(check1);
  });

  it("preserves CheckMap across StoreField on same object", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = graph.addParameter(0);
    const check1 = irCheckMap(obj, 42);
    block.addNode(check1);
    const store = irStoreField(obj, 0, irConstant(1));
    block.addNode(store);
    const check2 = irCheckMap(obj, 42);
    block.addNode(check2);
    const ret = irReturn(check2);
    block.addNode(ret);
    const count = eliminateRedundantChecks(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(check1);
  });

  it("preserves CheckMap across multiple StoreFields to different offsets", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = graph.addParameter(0);
    const check1 = irCheckMap(obj, 42);
    block.addNode(check1);
    const s1 = irStoreField(obj, 0, irConstant(1));
    block.addNode(s1);
    const s2 = irStoreField(obj, 1, irConstant(2));
    block.addNode(s2);
    const s3 = irStoreField(obj, 2, irConstant(3));
    block.addNode(s3);
    const check2 = irCheckMap(obj, 42);
    block.addNode(check2);
    const ret = irReturn(check2);
    block.addNode(ret);
    const count = eliminateRedundantChecks(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(check1);
  });

  it("eliminates CheckMap in dominated block across StoreField", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const obj = graph.addParameter(0);
    const check1 = irCheckMap(obj, 42);
    b0.addNode(check1);
    const store = irStoreField(obj, 0, irConstant(5));
    b0.addNode(store);
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));
    const check2 = irCheckMap(obj, 42);
    b1.addNode(check2);
    const ret = irReturn(check2);
    b1.addNode(ret);
    const count = eliminateRedundantChecks(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(check1);
  });
});

describe("rangeAnalysisAndBoundsCheckElimination", () => {
  it("marks noOverflow on add with small constant ranges", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const a = irConstant(5);
    const b = irConstant(10);
    block.addNode(a);
    block.addNode(b);
    const add = irInt32Add(a, b);
    block.addNode(add);
    const ret = irReturn(add);
    block.addNode(ret);
    rangeAnalysisAndBoundsCheckElimination(graph);
    expect(add.props.noOverflow).toBe(true);
  });

  it("folds always-true branch comparison", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    const a = irConstant(3);
    const b = irConstant(10);
    b0.addNode(a);
    b0.addNode(b);
    const cmp = irInt32Compare("<", a, b);
    b0.addNode(cmp);
    const br = irBranch(cmp, b1, b2);
    b0.addNode(br);
    b0.addSuccessor(b1);
    b0.addSuccessor(b2);
    b1.addNode(irReturn(irConstant(1)));
    b2.addNode(irReturn(irConstant(0)));
    const count = rangeAnalysisAndBoundsCheckElimination(graph);
    expect(count).toBeGreaterThan(0);
    const term = b0.getTerminator();
    expect(term.type).toBe(IR_JUMP);
    expect(term.props.targetBlock).toBe(b1.id);
  });

  it("folds always-false branch comparison", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    const a = irConstant(20);
    const b = irConstant(5);
    b0.addNode(a);
    b0.addNode(b);
    const cmp = irInt32Compare("<", a, b);
    b0.addNode(cmp);
    const br = irBranch(cmp, b1, b2);
    b0.addNode(br);
    b0.addSuccessor(b1);
    b0.addSuccessor(b2);
    b1.addNode(irReturn(irConstant(1)));
    b2.addNode(irReturn(irConstant(0)));
    const count = rangeAnalysisAndBoundsCheckElimination(graph);
    expect(count).toBeGreaterThan(0);
    const term = b0.getTerminator();
    expect(term.type).toBe(IR_JUMP);
    expect(term.props.targetBlock).toBe(b2.id);
  });

  it("computes range for subtraction", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const a = irConstant(10);
    const b = irConstant(3);
    block.addNode(a);
    block.addNode(b);
    const sub = irInt32Sub(a, b);
    block.addNode(sub);
    const ret = irReturn(sub);
    block.addNode(ret);
    rangeAnalysisAndBoundsCheckElimination(graph);
    expect(sub.props.noOverflow).toBe(true);
  });

  it("handles == comparison folding", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    const a = irConstant(7);
    const b = irConstant(7);
    b0.addNode(a);
    b0.addNode(b);
    const cmp = irInt32Compare("==", a, b);
    b0.addNode(cmp);
    const br = irBranch(cmp, b1, b2);
    b0.addNode(br);
    b0.addSuccessor(b1);
    b0.addSuccessor(b2);
    b1.addNode(irReturn(irConstant(1)));
    b2.addNode(irReturn(irConstant(0)));
    const count = rangeAnalysisAndBoundsCheckElimination(graph);
    expect(count).toBeGreaterThan(0);
    expect(b0.getTerminator().type).toBe(IR_JUMP);
    expect(b0.getTerminator().props.targetBlock).toBe(b1.id);
  });

  it("handles != comparison folding", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    const a = irConstant(3);
    const b = irConstant(10);
    b0.addNode(a);
    b0.addNode(b);
    const cmp = irInt32Compare("!=", a, b);
    b0.addNode(cmp);
    const br = irBranch(cmp, b1, b2);
    b0.addNode(br);
    b0.addSuccessor(b1);
    b0.addSuccessor(b2);
    b1.addNode(irReturn(irConstant(1)));
    b2.addNode(irReturn(irConstant(0)));
    const count = rangeAnalysisAndBoundsCheckElimination(graph);
    expect(count).toBeGreaterThan(0);
    expect(b0.getTerminator().props.targetBlock).toBe(b1.id);
  });
});
