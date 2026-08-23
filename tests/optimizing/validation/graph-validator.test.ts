import { describe, it, expect, beforeEach } from "vitest";
import {
  GraphValidationError,
  validateOptimizedGraph,
  validateRepresentations,
} from "../../../src/optimizing/validation/graph-validator.js";
import {
  REP_BOOL,
  REP_FLOAT64,
  REP_HANDLE,
  REP_INT32,
} from "../../../src/optimizing/types/representation.js";
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
} from "../../../src/optimizing/ir/index.js";
import { link, addPhi } from "../../../src/optimizing/ir/cfg-edit.js";

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
    link(b0, b1);
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
    link(b0, b1);
    link(b0, b2);
    link(b1, b3);
    b1.addNode(irJump(b3));
    link(b2, b3);
    b2.addNode(irJump(b3));
    b3.addNode(irReturn(irConstant(0)));
    expect(validateOptimizedGraph(graph)).toBe(true);
  });

  it("throws for empty graph", () => {
    const graph = new CFGFunction("test");
    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
  });

  it("throws when two nodes in a block claim the same id", () => {
    const graph = new CFGFunction("collides");
    const block = graph.addBlock();
    const value = block.addNode(irConstant(1));
    const returned = block.addNode(irReturn(value));
    returned.id = value.id;

    expect(() => validateOptimizedGraph(graph)).toThrow(GraphValidationError);
    expect(() => validateOptimizedGraph(graph)).toThrow(/names both Constant and Return/);
  });

  it("passes when the same node is listed once per block", () => {
    const graph = new CFGFunction("unique");
    const block = graph.addBlock();
    const value = block.addNode(irConstant(1));
    block.addNode(irReturn(value));

    expect(validateOptimizedGraph(graph)).toBe(true);
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
    link(b0, b1);
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
    link(b0, b1);
    link(b0, b2);
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

  it("accepts a phi whose input count matches the predecessor count", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const c = irConstant(1);
    b0.addNode(c);
    b0.addNode(irJump(b1));
    link(b0, b1);
    const phi = addPhi(b1, [c]);
    b1.addNode(irReturn(phi));

    expect(phi.inputs).toHaveLength(b1.predecessors.length);
    expect(validateOptimizedGraph(graph)).toBe(true);
  });

  it("throws when a phi has fewer inputs than the block has predecessors", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const b2 = graph.addBlock();
    const merge = graph.addBlock();
    const cond = irConstant(1);
    const value = irConstant(2);
    b0.addNode(cond);
    b0.addNode(value);
    b0.addNode(irBranch(cond, b1, b2));
    link(b0, b1);
    link(b0, b2);
    b1.addNode(irJump(merge));
    link(b1, merge);
    b2.addNode(irJump(merge));
    link(b2, merge);

    const phi = addPhi(merge, [value, value]);
    merge.addNode(irReturn(phi));
    expect(validateOptimizedGraph(graph)).toBe(true);

    phi.inputs.pop();

    expect(phi.inputs.length).toBeLessThan(merge.predecessors.length);
    expect(() => validateOptimizedGraph(graph)).toThrow(/1 inputs for 2 predecessors/);
  });

  it("throws when a phi has more inputs than the block has predecessors", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const c = irConstant(1);
    b0.addNode(c);
    b0.addNode(irJump(b1));
    link(b0, b1);
    const phi = addPhi(b1, [c]);
    b1.addNode(irReturn(phi));
    expect(validateOptimizedGraph(graph)).toBe(true);

    phi.addInput(c);

    expect(phi.inputs.length).toBeGreaterThan(b1.predecessors.length);
    expect(() => validateOptimizedGraph(graph)).toThrow(/2 inputs for 1 predecessors/);
  });

  it("throws when a node carries an opcode the property table does not describe", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const value = irConstant(1);
    block.addNode(value);
    block.addNode(irReturn(value));
    expect(validateOptimizedGraph(graph)).toBe(true);

    value.type = "NotAnOperation";

    expect(() => validateOptimizedGraph(graph)).toThrow(
      /no operation spec for NotAnOperation/,
    );
  });
});

describe("validateRepresentations", () => {
  const twoReturns = (left: string, right: string) => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const first = graph.addBlock();
    const second = graph.addBlock();

    const cond = irConstant(true);
    cond.props._rep = REP_BOOL;
    entry.addNode(cond);
    link(entry, first);
    link(entry, second);
    entry.addNode(irBranch(cond, first, second));

    const a = irConstant(1);
    a.props._rep = left;
    first.addNode(a);
    first.addNode(irReturn(a));

    const b = irConstant(2);
    b.props._rep = right;
    second.addNode(b);
    second.addNode(irReturn(b));

    return graph;
  };

  it("passes when every return matches the declared representation", () => {
    const graph = twoReturns(REP_INT32, REP_FLOAT64);
    graph.returnRepresentation = REP_FLOAT64;

    expect(validateRepresentations(graph)).toBe(true);
  });

  it("rejects a return whose abi representation differs from the declared one", () => {
    const graph = twoReturns(REP_INT32, REP_HANDLE);
    graph.returnRepresentation = REP_INT32;

    expect(() => validateRepresentations(graph)).toThrow(
      /returns handle but the graph declares tagged-number/,
    );
  });

  it("rejects a value-producing node the legalizer never stamped", () => {
    const graph = twoReturns(REP_INT32, REP_INT32);
    graph.returnRepresentation = REP_INT32;
    const stray = irConstant(9);
    stray.props._rep = REP_INT32;
    graph.blocks[1].nodes.unshift(stray);
    stray.block = graph.blocks[1];
    expect(validateRepresentations(graph)).toBe(true);

    delete stray.props._rep;

    expect(() => validateRepresentations(graph)).toThrow(
      /v\d+ Constant has no representation/,
    );
  });

  it("rejects a graph that never declared a return representation", () => {
    const graph = twoReturns(REP_INT32, REP_INT32);

    expect(() => validateRepresentations(graph)).toThrow(
      /no return representation/,
    );
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
