import { describe, it, expect, beforeEach } from "vitest";
import { sparseConditionalConstantPropagation } from "../../../src/optimizing/passes/sccp.js";
import { addPhi, link } from "../../../src/optimizing/ir/cfg-edit.js";
import {
  CFGFunction,
  IR_JUMP,
  IR_PHI,
  irBranch,
  irJump,
  irConstant,
  irInt32Add,
  irInt32Sub,
  irInt32Mul,
  irInt32Div,
  irInt32Mod,
  irInt32Shl,
  irInt32Shr,
  irInt32And,
  irInt32Compare,
  irFloat64Add,
  irFloat64Sub,
  irFloat64Mul,
  irFloat64Div,
  irNot,
  irNeg,
  irReturn,
  irGenericAdd,
  irCheckSmi,
  irCheckNumber,
  IR_CONSTANT,
  IR_INT32_ADD,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";

function makeGraph(name = "test") {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  return { graph, block };
}

beforeEach(() => resetIRNodeIds());

describe("sparseConditionalConstantPropagation", () => {
  describe("arithmetic", () => {
    it("folds Int32Add of two constants", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(10);
      const b = irConstant(32);
      block.addNode(a);
      block.addNode(b);
      const add = irInt32Add(a, b);
      block.addNode(add);
      const ret = irReturn(add);
      block.addNode(ret);
      const count = sparseConditionalConstantPropagation(graph);
      expect(count).toBeGreaterThan(0);
      expect(ret.inputs[0].type).toBe(IR_CONSTANT);
      expect(ret.inputs[0].props.value).toBe(42);
    });

    it("folds Int32Sub", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(50);
      const b = irConstant(8);
      block.addNode(a);
      block.addNode(b);
      const sub = irInt32Sub(a, b);
      block.addNode(sub);
      const ret = irReturn(sub);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(42);
    });

    it("folds Int32Mul to the exact product, not wrapped imul semantics", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(0x7FFFFFFF);
      const b = irConstant(2);
      block.addNode(a);
      block.addNode(b);
      const mul = irInt32Mul(a, b);
      block.addNode(mul);
      const ret = irReturn(mul);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(0x7FFFFFFF * 2);
      expect(ret.inputs[0].props.value).not.toBe(Math.imul(0x7FFFFFFF, 2));
    });

    it("folds a multiply that was settled as wrapping the way int32 wraps", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(0x7fffffff);
      const b = irConstant(2);
      block.addNode(a);
      block.addNode(b);
      const mul = irInt32Mul(a, b);
      mul.props.noOverflow = true;
      block.addNode(mul);
      const ret = irReturn(mul);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(Math.imul(0x7fffffff, 2));
    });

    it("folds Int32Mul of opposite signs to negative zero", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(0);
      const b = irConstant(-3);
      block.addNode(a);
      block.addNode(b);
      const mul = irInt32Mul(a, b);
      block.addNode(mul);
      const ret = irReturn(mul);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(Object.is(ret.inputs[0].props.value, -0)).toBe(true);
    });

    it("folds Int32Div (avoids div by zero)", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(20);
      const b = irConstant(4);
      block.addNode(a);
      block.addNode(b);
      const div = irInt32Div(a, b);
      block.addNode(div);
      const ret = irReturn(div);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(5);
    });

    it("folds Int32Div by zero to Infinity (JS number semantics)", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(10);
      const b = irConstant(0);
      block.addNode(a);
      block.addNode(b);
      const div = irInt32Div(a, b);
      block.addNode(div);
      const ret = irReturn(div);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(Infinity);
    });

    it("folds Int32Mod by zero to NaN (JS number semantics)", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(10);
      const b = irConstant(0);
      block.addNode(a);
      block.addNode(b);
      const mod = irInt32Mod(a, b);
      block.addNode(mod);
      const ret = irReturn(mod);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(Number.isNaN(ret.inputs[0].props.value)).toBe(true);
    });

    it("folds Int32Mod", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(17);
      const b = irConstant(5);
      block.addNode(a);
      block.addNode(b);
      const mod = irInt32Mod(a, b);
      block.addNode(mod);
      const ret = irReturn(mod);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(2);
    });

    it("folds shift and bitwise ops", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(8);
      const b = irConstant(2);
      block.addNode(a);
      block.addNode(b);
      const shl = irInt32Shl(a, b);
      block.addNode(shl);
      const ret = irReturn(shl);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(32);
    });

    it("folds Float64Add", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(1.5);
      const b = irConstant(2.5);
      block.addNode(a);
      block.addNode(b);
      const add = irFloat64Add(a, b);
      block.addNode(add);
      const ret = irReturn(add);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(4.0);
    });

    it("folds Float64Mul", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(3.0);
      const b = irConstant(7.0);
      block.addNode(a);
      block.addNode(b);
      const mul = irFloat64Mul(a, b);
      block.addNode(mul);
      const ret = irReturn(mul);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(21.0);
    });
  });

  describe("comparison folding", () => {
    it("folds Int32Compare <", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(3);
      const b = irConstant(5);
      block.addNode(a);
      block.addNode(b);
      const cmp = irInt32Compare("<", a, b);
      block.addNode(cmp);
      const ret = irReturn(cmp);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(true);
    });

    it("folds Int32Compare == when not equal", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(3);
      const b = irConstant(5);
      block.addNode(a);
      block.addNode(b);
      const cmp = irInt32Compare("==", a, b);
      block.addNode(cmp);
      const ret = irReturn(cmp);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(false);
    });
  });

  describe("unary folding", () => {
    it("folds Not of constant truthy to false", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(1);
      block.addNode(a);
      const not = irNot(a);
      block.addNode(not);
      const ret = irReturn(not);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(false);
    });

    it("folds Not of constant 0 to true", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(0);
      block.addNode(a);
      const not = irNot(a);
      block.addNode(not);
      const ret = irReturn(not);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(true);
    });

    it("folds Neg of constant", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(5);
      block.addNode(a);
      const neg = irNeg(a);
      block.addNode(neg);
      const ret = irReturn(neg);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe(-5);
    });

  });

  describe("string concat folding", () => {
    it("folds GenericAdd of two string constants", () => {
      const { graph, block } = makeGraph();
      const a = irConstant("hello ");
      const b = irConstant("world");
      block.addNode(a);
      block.addNode(b);
      const add = irGenericAdd(a, b);
      block.addNode(add);
      const ret = irReturn(add);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].props.value).toBe("hello world");
    });
  });

  describe("iterative folding", () => {
    it("folds chain: (2+3) * 0 => first fold 2+3=5, then 5*0=0", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(2);
      const b = irConstant(3);
      const zero = irConstant(0);
      block.addNode(a);
      block.addNode(b);
      block.addNode(zero);
      const add = irInt32Add(a, b);
      block.addNode(add);
      const mul = irInt32Mul(add, zero);
      block.addNode(mul);
      const ret = irReturn(mul);
      block.addNode(ret);
      sparseConditionalConstantPropagation(graph);
      expect(ret.inputs[0].type).toBe(IR_CONSTANT);
      expect(ret.inputs[0].props.value).toBe(0);
    });
  });

describe("conditional reachability", () => {
  function diamond(condition: boolean) {
    const graph = new CFGFunction("diamond");
    const entry = graph.addBlock();
    const taken = graph.addBlock();
    const skipped = graph.addBlock();
    const merge = graph.addBlock();

    const flag = irConstant(condition);
    entry.addNode(flag);
    entry.addNode(irBranch(flag, taken, skipped));
    link(entry, taken);
    link(entry, skipped);

    const one = irConstant(1);
    taken.addNode(one);
    taken.addNode(irJump(merge));
    link(taken, merge);

    const two = irConstant(2);
    skipped.addNode(two);
    skipped.addNode(irJump(merge));
    link(skipped, merge);

    const phi = addPhi(merge, [one, two]);
    const ret = irReturn(phi);
    merge.addNode(ret);
    graph.rebuildUses();
    return { graph, entry, taken, skipped, merge, phi, ret };
  }

  it("resolves a phi whose other predecessor cannot be reached", () => {
    const { graph, ret } = diamond(false);

    sparseConditionalConstantPropagation(graph);

    expect(ret.inputs[0].type).toBe(IR_CONSTANT);
    expect(ret.inputs[0].props.value).toBe(2);
  });

  it("resolves the same phi to the other constant when the condition flips", () => {
    const { graph, ret } = diamond(true);

    sparseConditionalConstantPropagation(graph);

    expect(ret.inputs[0].type).toBe(IR_CONSTANT);
    expect(ret.inputs[0].props.value).toBe(1);
  });

  it("rewrites the constant branch to a jump and drops the dead edge", () => {
    const { graph, entry, taken, skipped, merge } = diamond(false);

    sparseConditionalConstantPropagation(graph);

    expect(entry.getTerminator()!.type).toBe(IR_JUMP);
    expect(entry.successors).toEqual([skipped]);
    expect(taken.successors).toEqual([merge]);
  });

  it("leaves the phi alone when the condition is not a constant", () => {
    const graph = new CFGFunction("unknown");
    const parameter = graph.addParameter(0);
    const entry = graph.addBlock();
    const taken = graph.addBlock();
    const skipped = graph.addBlock();
    const merge = graph.addBlock();

    entry.addNode(irBranch(parameter, taken, skipped));
    link(entry, taken);
    link(entry, skipped);
    const one = irConstant(1);
    taken.addNode(one);
    taken.addNode(irJump(merge));
    link(taken, merge);
    const two = irConstant(2);
    skipped.addNode(two);
    skipped.addNode(irJump(merge));
    link(skipped, merge);
    const phi = addPhi(merge, [one, two]);
    const ret = irReturn(phi);
    merge.addNode(ret);
    graph.rebuildUses();

    sparseConditionalConstantPropagation(graph);

    expect(ret.inputs[0].type).toBe(IR_PHI);
    expect(entry.successors).toEqual([taken, skipped]);
  });

  it("still folds a phi whose reachable inputs agree", () => {
    const graph = new CFGFunction("agree");
    const parameter = graph.addParameter(0);
    const entry = graph.addBlock();
    const taken = graph.addBlock();
    const skipped = graph.addBlock();
    const merge = graph.addBlock();

    entry.addNode(irBranch(parameter, taken, skipped));
    link(entry, taken);
    link(entry, skipped);
    const left = irConstant(7);
    taken.addNode(left);
    taken.addNode(irJump(merge));
    link(taken, merge);
    const right = irConstant(7);
    skipped.addNode(right);
    skipped.addNode(irJump(merge));
    link(skipped, merge);
    const phi = addPhi(merge, [left, right]);
    const ret = irReturn(phi);
    merge.addNode(ret);
    graph.rebuildUses();

    sparseConditionalConstantPropagation(graph);

    expect(ret.inputs[0].type).toBe(IR_CONSTANT);
    expect(ret.inputs[0].props.value).toBe(7);
  });
});
});
