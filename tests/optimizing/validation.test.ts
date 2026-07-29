import { describe, it, expect, beforeEach } from "vitest";
import {
  GraphValidationError,
  validateOptimizedGraph,
} from "../../src/optimizing/validation/graph-validator.js";
import {
  CFGFunction,
  irConstant,
  irReturn,
  irJump,
  irBranch,
  irCheckSmi,
  irInt32Add,
  irNewObject,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

describe("validateOptimizedGraph", () => {
  it("passes for valid simple graph", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const c = irConstant(42);
    block.addNode(c);
    const ret = irReturn(c);
    block.addNode(ret);
    expect(validateOptimizedGraph(graph)).toBe(true);
  });

  it("passes for graph with parameters", () => {
    const graph = new CFGFunction("test");
    const p = graph.addParameter(0);
    const block = graph.addBlock();
    const ret = irReturn(p);
    block.addNode(ret);
    expect(validateOptimizedGraph(graph)).toBe(true);
  });

  it("passes for multi-block graph with correct edges", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));
    const c = irConstant(0);
    b1.addNode(c);
    b1.addNode(irReturn(c));
    expect(validateOptimizedGraph(graph)).toBe(true);
  });

  it("passes for diamond CFG", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    const b3 = graph.addBlock();
    const cond = irConstant(1);
    b0.addNode(cond);
    b0.addNode(irBranch(cond, b1, b2));
    b0.addSuccessor(b1);
    b0.addSuccessor(b2);
    b1.addSuccessor(b3);
    b1.addNode(irJump(b3));
    b2.addSuccessor(b3);
    b2.addNode(irJump(b3));
    b3.addNode(irReturn(irConstant(0)));
    expect(validateOptimizedGraph(graph)).toBe(true);
  });

  it("throws for empty graph", () => {
    const graph = new CFGFunction("test");
    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
  });

  it("throws when node.block is wrong", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const c = irConstant(0);
    b0.addNode(c);
    const ret = irReturn(c);
    b0.addNode(ret);
    b1.addNode(irReturn(irConstant(1)));
    ret.block = b1;
    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
  });

  it("throws when branch targets missing block", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const cond = irConstant(1);
    b0.addNode(cond);
    const br = irBranch(cond, b1, { id: 999 });
    b0.addNode(br);
    b0.addSuccessor(b1);
    b1.addNode(irReturn(irConstant(0)));
    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
  });

  it("throws when deopt-capable node lacks frame state", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const p = graph.addParameter(0);
    const check = irCheckSmi(p);
    block.addNode(check);
    const ret = irReturn(check);
    block.addNode(ret);
    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
  });

  it("passes when deopt-capable node has frame state", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const p = graph.addParameter(0);
    const check = irCheckSmi(p);
    const fs = { id: 0, localValues: new Map(), stackValues: [] };
    check.frameState = fs;
    block.addNode(check);
    const ret = irReturn(check);
    block.addNode(ret);
    expect(validateOptimizedGraph(graph, [fs])).toBe(true);
  });

  it("throws when use-def dominance is violated", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    const cond = irConstant(1);
    b0.addNode(cond);
    b0.addNode(irBranch(cond, b1, b2));
    b0.addSuccessor(b1);
    b0.addSuccessor(b2);
    const p = graph.addParameter(0);
    const addInB1 = irInt32Add(p, irConstant(1));
    addInB1.props.noOverflow = true;
    b1.addNode(addInB1);
    b1.addNode(irReturn(addInB1));
    const useInB2 = irReturn(addInB1);
    b2.addNode(useInB2);
    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
  });

  it("throws for successor/predecessor mismatch", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    b0.successors.push(b1);
    b0.addNode(irJump(b1));
    b1.addNode(irReturn(irConstant(0)));
    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
  });

  it("throws when nodes appear after terminator", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const c = irConstant(0);
    block.addNode(c);
    const ret = irReturn(c);
    block.addNode(ret);
    const extra = irConstant(99);
    block.nodes.push(extra);
    extra.block = block;
    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
  });

  it("validates block params input count matches predecessor count", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    b0.addSuccessor(b1);
    const c = irConstant(1);
    b0.addNode(c);
    b0.addSuccessor(b1, [c]);
    b0.setEdgeArgs(b1, [c]);
    b0.addNode(irJump(b1));
    const param = b1.addParam([c]);
    b1.addNode(irReturn(param));
    expect(validateOptimizedGraph(graph)).toBe(true);
  });
});

describe("GraphValidationError", () => {
  it("carries errors array", () => {
    const err = new GraphValidationError(["error1", "error2"]);
    expect(err.errors).toEqual(["error1", "error2"]);
    expect(err.message).toContain("error1");
    expect(err.message).toContain("error2");
    expect(err.name).toBe("GraphValidationError");
  });
});
