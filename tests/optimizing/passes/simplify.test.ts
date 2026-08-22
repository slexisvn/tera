import { describe, it, expect, beforeEach } from "vitest";
import {
  algebraicSimplification,
  strengthReduction,
} from "../../../src/optimizing/passes/simplify.js";
import {
  CFGFunction,
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
  IR_CONSTANT,
  IR_INT32_SHL,
  IR_INT32_AND,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

function makeGraph(name = "test") {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  return { graph, block };
}

beforeEach(() => resetIRNodeIds());

describe("algebraicSimplification", () => {
  it("x + 0 => x", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const zero = irConstant(0);
    block.addNode(zero);
    const add = irInt32Add(p, zero);
    block.addNode(add);
    const ret = irReturn(add);
    block.addNode(ret);
    algebraicSimplification(graph);
    expect(ret.inputs[0]).toBe(p);
  });

  it("0 + x => x", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const zero = irConstant(0);
    block.addNode(zero);
    const add = irInt32Add(zero, p);
    block.addNode(add);
    const ret = irReturn(add);
    block.addNode(ret);
    algebraicSimplification(graph);
    expect(ret.inputs[0]).toBe(p);
  });

  it("x * 1 => x", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const one = irConstant(1);
    block.addNode(one);
    const mul = irInt32Mul(p, one);
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    algebraicSimplification(graph);
    expect(ret.inputs[0]).toBe(p);
  });

  it("does NOT reduce x * 0 to 0 (unsound: negative x yields -0, NaN and Infinity yield NaN)", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const zero = irConstant(0);
    block.addNode(zero);
    const mul = irInt32Mul(p, zero);
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    algebraicSimplification(graph);
    expect(ret.inputs[0].type).toBe(IR_INT32_MUL);
  });

  it("still reduces x * 1 to x", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const one = irConstant(1);
    block.addNode(one);
    const mul = irInt32Mul(p, one);
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    algebraicSimplification(graph);
    expect(ret.inputs[0]).toBe(p);
  });
});

describe("algebraicSimplification involutions", () => {
  it("cancels double negation", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const neg1 = irNeg(p);
    block.addNode(neg1);
    const neg2 = irNeg(neg1);
    block.addNode(neg2);
    const ret = irReturn(neg2);
    block.addNode(ret);
    algebraicSimplification(graph);
    expect(ret.inputs[0]).toBe(p);
  });

  it("cancels double not over a boolean-producing value", () => {
    const { graph, block } = makeGraph();
    const a = graph.addParameter(0);
    const b = graph.addParameter(1);
    const cmp = irInt32Compare("<", a, b);
    block.addNode(cmp);
    const not1 = irNot(cmp);
    block.addNode(not1);
    const not2 = irNot(not1);
    block.addNode(not2);
    const ret = irReturn(not2);
    block.addNode(ret);
    algebraicSimplification(graph);
    expect(ret.inputs[0]).toBe(cmp);
  });

  it("keeps double not over a non-boolean value (it coerces to boolean)", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const not1 = irNot(p);
    block.addNode(not1);
    const not2 = irNot(not1);
    block.addNode(not2);
    const ret = irReturn(not2);
    block.addNode(ret);
    algebraicSimplification(graph);
    expect(ret.inputs[0]).toBe(not2);
  });
});

describe("strengthReduction", () => {
  it("reduces multiply by power of 2 to shift", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(8);
    block.addNode(c);
    const mul = irInt32Mul(p, c);
    mul.props.noOverflow = true;
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    const count = strengthReduction(graph);
    expect(count).toBeGreaterThan(0);
    const replaced = ret.inputs[0];
    expect(replaced.type).toBe(IR_INT32_SHL);
    expect(replaced.inputs[1].props.value).toBe(3);
  });

  it("reduces multiply by 2 to shift left 1", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(2);
    block.addNode(c);
    const mul = irInt32Mul(p, c);
    mul.props.noOverflow = true;
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    strengthReduction(graph);
    expect(ret.inputs[0].type).toBe(IR_INT32_SHL);
    expect(ret.inputs[0].inputs[1].props.value).toBe(1);
  });

  it("does NOT reduce multiply by power of 2 to shift when overflow is possible", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(2);
    block.addNode(c);
    const mul = irInt32Mul(p, c);
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    strengthReduction(graph);
    expect(ret.inputs[0].type).toBe(mul.type);
  });

  it("does NOT decompose multiply by 3 when overflow is possible", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(3);
    block.addNode(c);
    const mul = irInt32Mul(p, c);
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    strengthReduction(graph);
    expect(ret.inputs[0].type).toBe(mul.type);
  });

  it("does NOT reduce divide by power of 2 to shift (unsound for negative dividends)", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(4);
    block.addNode(c);
    const div = irInt32Div(p, c);
    block.addNode(div);
    const ret = irReturn(div);
    block.addNode(ret);
    strengthReduction(graph);
    expect(ret.inputs[0].type).toBe(div.type);
  });

  it("does NOT reduce mod by power of 2 to bitwise-and (unsound for negative dividends)", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(16);
    block.addNode(c);
    const mod = irInt32Mod(p, c);
    block.addNode(mod);
    const ret = irReturn(mod);
    block.addNode(ret);
    strengthReduction(graph);
    expect(ret.inputs[0].type).toBe(mod.type);
  });

  it("decomposes multiply by 3 to (x << 1) + x", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(3);
    block.addNode(c);
    const mul = irInt32Mul(p, c);
    mul.props.noOverflow = true;
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    strengthReduction(graph);
    const replaced = ret.inputs[0];
    expect(replaced.type).toBe(IR_INT32_ADD);
    expect(replaced.inputs[0].type).toBe(IR_INT32_SHL);
  });

  it("decomposes multiply by 7 to (x << 3) - x", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(7);
    block.addNode(c);
    const mul = irInt32Mul(p, c);
    mul.props.noOverflow = true;
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    strengthReduction(graph);
    const replaced = ret.inputs[0];
    expect(replaced.type).toBe(IR_INT32_SUB);
    expect(replaced.inputs[0].type).toBe(IR_INT32_SHL);
  });

  it("reduces x - x to 0", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const sub = irInt32Sub(p, p);
    block.addNode(sub);
    const ret = irReturn(sub);
    block.addNode(ret);
    strengthReduction(graph);
    expect(ret.inputs[0].type).toBe(IR_CONSTANT);
    expect(ret.inputs[0].props.value).toBe(0);
  });

  it("handles constant on left side of multiply", () => {
    const { graph, block } = makeGraph();
    const c = irConstant(4);
    block.addNode(c);
    const p = graph.addParameter(0);
    const mul = irInt32Mul(c, p);
    mul.props.noOverflow = true;
    block.addNode(mul);
    const ret = irReturn(mul);
    block.addNode(ret);
    strengthReduction(graph);
    expect(ret.inputs[0].type).toBe(IR_INT32_SHL);
    expect(ret.inputs[0].inputs[1].props.value).toBe(2);
  });
});

describe("strengthReduction def-use bookkeeping", () => {
  it("drops the replaced multiply from the use lists of its inputs", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(8);
    block.addNode(c);
    const mul = irInt32Mul(p, c);
    mul.props.noOverflow = true;
    block.addNode(mul);
    block.addNode(irReturn(mul));

    strengthReduction(graph);

    expect(p.uses).not.toContain(mul);
    expect(c.uses).not.toContain(mul);
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("drops the replaced multiply when it decomposes into a shift and an add", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const c = irConstant(3);
    block.addNode(c);
    const mul = irInt32Mul(p, c);
    mul.props.noOverflow = true;
    block.addNode(mul);
    block.addNode(irReturn(mul));

    strengthReduction(graph);

    expect(p.uses).not.toContain(mul);
    expect(c.uses).not.toContain(mul);
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("drops a subtraction of a value from itself from that value's use list", () => {
    const { graph, block } = makeGraph();
    const p = graph.addParameter(0);
    const sub = irInt32Sub(p, p);
    block.addNode(sub);
    block.addNode(irReturn(sub));

    strengthReduction(graph);

    expect(p.uses).not.toContain(sub);
    expect(validateGraphInvariants(graph)).toBe(true);
  });
});
