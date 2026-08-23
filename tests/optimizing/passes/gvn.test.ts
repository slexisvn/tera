import { describe, it, expect, beforeEach } from "vitest";
import { globalValueNumbering } from "../../../src/optimizing/passes/gvn.js";
import { DominatorTree } from "../../../src/optimizing/analyses/dominance.js";
import {
  CFGBlock,
  CFGFunction,
  CFGInstruction,
  irBranch,
  irConstant,
  irInt32Add,
  irInt32Mul,
  irReturn,
  irJump,
  irLoadField,
  irStoreField,
  IR_INT32_ADD,
  IR_PHI,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

function makeGraph() {
  const graph = new CFGFunction("test");
  const block = graph.addBlock();
  return { graph, block };
}

function runGvn(graph: CFGFunction): number {
  const count = globalValueNumbering(graph, new DominatorTree(graph));
  validateGraphInvariants(graph);
  return count;
}

function nodesOf(graph: CFGFunction, type: string): CFGInstruction[] {
  return graph.blocks.flatMap((block) => block.nodes.filter((node) => node.type === type));
}

function addsIn(block: CFGBlock): CFGInstruction[] {
  return block.nodes.filter((node) => node.type === IR_INT32_ADD);
}

function diamond(): {
  graph: CFGFunction;
  entry: CFGBlock;
  taken: CFGBlock;
  other: CFGBlock;
  join: CFGBlock;
  left: CFGInstruction;
  right: CFGInstruction;
} {
  const graph = new CFGFunction("diamond");
  const entry = graph.addBlock();
  const taken = graph.addBlock();
  const other = graph.addBlock();
  const join = graph.addBlock();
  const left = graph.addParameter(0);
  const right = graph.addParameter(1);
  const flag = irConstant(true);
  entry.addNode(flag);
  link(entry, taken);
  link(entry, other);
  entry.addNode(irBranch(flag, taken, other));
  link(taken, join);
  taken.addNode(irJump(join));
  link(other, join);
  other.addNode(irJump(join));
  return { graph, entry, taken, other, join, left, right };
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
    const count = runGvn(graph);
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
    const count = runGvn(graph);
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
    const count = runGvn(graph);
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
    link(b0, b1);
    b0.addNode(irJump(b1));
    const add2 = irInt32Add(a, b);
    b1.addNode(add2);
    const ret = irReturn(add2);
    b1.addNode(ret);
    const count = runGvn(graph);
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
    const count = runGvn(graph);
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
    const count = runGvn(graph);
    expect(count).toBe(0);
  });

  it("numbers equal constants written by different nodes as one value", () => {
    const { graph, block } = makeGraph();
    const param = graph.addParameter(0);
    const first = irConstant(7);
    const second = irConstant(7);
    block.addNode(first);
    block.addNode(second);
    const add1 = irInt32Add(param, first);
    block.addNode(add1);
    const add2 = irInt32Add(param, second);
    block.addNode(add2);
    const ret = irReturn(add2);
    block.addNode(ret);
    const count = runGvn(graph);
    expect(count).toBeGreaterThan(0);
    expect(ret.inputs[0]).toBe(add1);
  });

  it("keeps expressions apart when a distinguishing property differs", () => {
    const { graph, block } = makeGraph();
    const param = graph.addParameter(0);
    const loose = irInt32Add(param, param);
    const checked = irInt32Add(param, param);
    checked.props.noOverflow = true;
    block.addNode(loose);
    block.addNode(checked);
    block.addNode(irReturn(checked));
    expect(runGvn(graph)).toBe(0);
  });

  it("treats equal metadata records on two nodes as the same value", () => {
    const { graph, block } = makeGraph();
    const param = graph.addParameter(0);
    const first = irInt32Add(param, param);
    first.props.domain = { kind: "range", bounds: [0, 4] };
    const second = irInt32Add(param, param);
    second.props.domain = { kind: "range", bounds: [0, 4] };
    block.addNode(first);
    block.addNode(second);
    const ret = irReturn(second);
    block.addNode(ret);
    expect(runGvn(graph)).toBeGreaterThan(0);
    expect(ret.inputs[0]).toBe(first);
  });

  it("keeps nodes apart when their metadata records differ", () => {
    const { graph, block } = makeGraph();
    const param = graph.addParameter(0);
    const first = irInt32Add(param, param);
    first.props.domain = { kind: "range", bounds: [0, 4] };
    const second = irInt32Add(param, param);
    second.props.domain = { kind: "range", bounds: [0, 5] };
    block.addNode(first);
    block.addNode(second);
    block.addNode(irReturn(second));
    expect(runGvn(graph)).toBe(0);
  });

  it("terminates on a metadata record that refers to itself", () => {
    const { graph, block } = makeGraph();
    const param = graph.addParameter(0);
    const looping: Record<string, unknown> = { kind: "self" };
    looping.self = looping;
    const first = irInt32Add(param, param);
    first.props.domain = looping;
    const second = irInt32Add(param, param);
    second.props.domain = looping;
    block.addNode(first);
    block.addNode(second);
    const ret = irReturn(second);
    block.addNode(ret);
    expect(runGvn(graph)).toBeGreaterThan(0);
    expect(ret.inputs[0]).toBe(first);
  });

  it("compares constants that hold objects by identity", () => {
    const { graph, block } = makeGraph();
    const param = graph.addParameter(0);
    const first = irConstant({});
    const second = irConstant({});
    block.addNode(first);
    block.addNode(second);
    const add1 = irInt32Add(param, first);
    const add2 = irInt32Add(param, second);
    block.addNode(add1);
    block.addNode(add2);
    block.addNode(irReturn(add2));
    expect(runGvn(graph)).toBe(0);
  });

  it("separates positive and negative zero constants", () => {
    const { graph, block } = makeGraph();
    const param = graph.addParameter(0);
    const positive = irConstant(0);
    const negative = irConstant(-0);
    block.addNode(positive);
    block.addNode(negative);
    const add1 = irInt32Add(param, positive);
    const add2 = irInt32Add(param, negative);
    block.addNode(add1);
    block.addNode(add2);
    block.addNode(irReturn(add2));
    expect(runGvn(graph)).toBe(0);
  });
});

describe("globalValueNumbering partial redundancy", () => {
  it("inserts on the edge that lacks the expression and merges with a phi", () => {
    const { graph, taken, other, join, left, right } = diamond();
    const early = irInt32Add(left, right);
    taken.nodes.splice(taken.nodes.length - 1, 0, early);
    early.block = taken;
    const late = irInt32Add(left, right);
    join.addNode(late);
    const ret = irReturn(late);
    join.addNode(ret);

    expect(runGvn(graph)).toBeGreaterThan(0);

    const phis = nodesOf(graph, IR_PHI);
    expect(phis).toHaveLength(1);
    expect(ret.inputs[0]).toBe(phis[0]);
    expect(join.nodes).not.toContain(late);
    expect(addsIn(taken)).toEqual([early]);
    expect(addsIn(other)).toHaveLength(1);
    expect(phis[0]!.inputs).toEqual([early, addsIn(other)[0]]);
  });

  it("leaves an expression alone when no predecessor already has it", () => {
    const { graph, join, left, right } = diamond();
    const late = irInt32Add(left, right);
    join.addNode(late);
    join.addNode(irReturn(late));

    expect(runGvn(graph)).toBe(0);
    expect(nodesOf(graph, IR_PHI)).toHaveLength(0);
  });

  it("splits a critical edge so the insertion stays off the other successor", () => {
    const graph = new CFGFunction("critical");
    const entry = graph.addBlock();
    const guarded = graph.addBlock();
    const join = graph.addBlock();
    const left = graph.addParameter(0);
    const right = graph.addParameter(1);
    const flag = irConstant(true);
    entry.addNode(flag);
    link(entry, guarded);
    link(entry, join);
    entry.addNode(irBranch(flag, guarded, join));
    const early = irInt32Add(left, right);
    guarded.addNode(early);
    link(guarded, join);
    guarded.addNode(irJump(join));
    const late = irInt32Add(left, right);
    join.addNode(late);
    const ret = irReturn(late);
    join.addNode(ret);

    const before = graph.blocks.length;
    expect(runGvn(graph)).toBeGreaterThan(0);

    expect(graph.blocks).toHaveLength(before + 1);
    const split = graph.blocks[before]!;
    expect(split.predecessors).toEqual([entry]);
    expect(split.successors).toEqual([join]);
    expect(entry.successors).toEqual([guarded, split]);
    expect(addsIn(split)).toHaveLength(1);
    expect(addsIn(entry)).toHaveLength(0);
    const phis = nodesOf(graph, IR_PHI);
    expect(phis).toHaveLength(1);
    expect(ret.inputs[0]).toBe(phis[0]);
  });

  it("merges with a phi and inserts nothing when every predecessor has the value", () => {
    const { graph, taken, other, join, left, right } = diamond();
    const fromTaken = irInt32Add(left, right);
    taken.nodes.splice(taken.nodes.length - 1, 0, fromTaken);
    fromTaken.block = taken;
    const fromOther = irInt32Mul(left, right);
    other.nodes.splice(other.nodes.length - 1, 0, fromOther);
    fromOther.block = other;
    const late = irInt32Mul(left, right);
    join.addNode(late);
    const ret = irReturn(late);
    join.addNode(ret);

    expect(runGvn(graph)).toBeGreaterThan(0);
    expect(addsIn(other)).toHaveLength(0);
    expect(ret.inputs[0]!.type).toBe(IR_PHI);
  });

  it("does not hoist into a loop across a back edge", () => {
    const graph = new CFGFunction("loop");
    const entry = graph.addBlock();
    const seeded = graph.addBlock();
    const bare = graph.addBlock();
    const header = graph.addBlock();
    const latch = graph.addBlock();
    const exit = graph.addBlock();
    const left = graph.addParameter(0);
    const right = graph.addParameter(1);
    const flag = irConstant(true);
    entry.addNode(flag);
    link(entry, seeded);
    link(entry, bare);
    entry.addNode(irBranch(flag, seeded, bare));
    const seed = irInt32Mul(left, right);
    seeded.addNode(seed);
    link(seeded, header);
    seeded.addNode(irJump(header));
    link(bare, header);
    bare.addNode(irJump(header));
    header.isLoopHeader = true;
    const inLoop = irInt32Mul(left, right);
    header.addNode(inLoop);
    link(header, latch);
    link(header, exit);
    header.addNode(irBranch(flag, latch, exit));
    link(latch, header);
    latch.addNode(irJump(header));
    exit.addNode(irReturn(inLoop));

    expect(runGvn(graph)).toBe(0);
    expect(latch.nodes).toHaveLength(1);
    expect(bare.nodes).toHaveLength(1);
    expect(nodesOf(graph, IR_PHI)).toHaveLength(0);
    expect(seeded.nodes).toContain(seed);
  });

  it("refuses to move a memory read onto a predecessor", () => {
    const { graph, taken, other, join, left } = diamond();
    const early = irLoadField(left, 0);
    taken.nodes.splice(taken.nodes.length - 1, 0, early);
    early.block = taken;
    const late = irLoadField(left, 0);
    join.addNode(late);
    join.addNode(irReturn(late));

    expect(runGvn(graph)).toBe(0);
    expect(other.nodes).toHaveLength(1);
  });

  it("refuses to move an expression whose operand is not available in a predecessor", () => {
    const { graph, taken, other, join, left } = diamond();
    const seededInTaken = irConstant(9);
    taken.nodes.splice(taken.nodes.length - 1, 0, seededInTaken);
    seededInTaken.block = taken;
    const early = irInt32Add(left, seededInTaken);
    taken.nodes.splice(taken.nodes.length - 1, 0, early);
    early.block = taken;
    const seededInJoin = irConstant(9);
    join.addNode(seededInJoin);
    const late = irInt32Add(left, seededInJoin);
    join.addNode(late);
    join.addNode(irReturn(late));

    expect(runGvn(graph)).toBe(0);
    expect(join.nodes).toContain(late);
    expect(other.nodes).toHaveLength(1);
  });

  it("translates a phi operand to its incoming value in each predecessor", () => {
    const { graph, taken, other, join, left, right } = diamond();
    const fromTaken = irInt32Add(left, right);
    taken.nodes.splice(taken.nodes.length - 1, 0, fromTaken);
    fromTaken.block = taken;
    const scaled = irInt32Mul(fromTaken, left);
    taken.nodes.splice(taken.nodes.length - 1, 0, scaled);
    scaled.block = taken;
    const fromOther = irInt32Mul(left, left);
    other.nodes.splice(other.nodes.length - 1, 0, fromOther);
    fromOther.block = other;
    const merge = new CFGInstruction(IR_PHI, { index: 0 });
    merge.addInput(fromTaken);
    merge.addInput(fromOther);
    merge.block = join;
    join.phis.push(merge);
    join.nodes.push(merge);
    const late = irInt32Mul(merge, left);
    join.addNode(late);
    const ret = irReturn(late);
    join.addNode(ret);

    expect(runGvn(graph)).toBeGreaterThan(0);

    const inserted = other.nodes.find((node) => node !== fromOther && node.type === late.type);
    expect(inserted?.inputs).toEqual([fromOther, left]);
    expect(join.nodes).not.toContain(late);
    expect(ret.inputs[0]!.type).toBe(IR_PHI);
    expect(ret.inputs[0]!.inputs).toEqual([scaled, inserted]);
  });

  it("gives every node it creates an unused identifier", () => {
    const { graph, taken, other, join, left, right } = diamond();
    const early = irInt32Add(left, right);
    taken.nodes.splice(taken.nodes.length - 1, 0, early);
    early.block = taken;
    const late = irInt32Add(left, right);
    join.addNode(late);
    join.addNode(irReturn(late));

    runGvn(graph);

    const ids = graph.blocks.flatMap((block) => block.nodes.map((node) => node.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
