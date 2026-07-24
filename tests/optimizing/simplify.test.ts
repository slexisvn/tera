import { describe, it, expect, beforeEach } from "vitest";
import {
  constantFolding,
  constantPropagation,
  strengthReduction,
} from "../../src/optimizing/passes/simplify.js";
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
  irStoreLocal,
  irLoadLocal,
  irCheckSmi,
  irCheckNumber,
  IR_CONSTANT,
  IR_INT32_SHL,
  IR_INT32_AND,
  IR_INT32_ADD,
  IR_INT32_SUB,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

function makeGraph(name = "test") {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  return { graph, block };
}

function nodeTypes(block) {
  return block.nodes.map(n => n.type);
}

function findConstant(block) {
  return block.nodes.find(n => n.type === IR_CONSTANT);
}

function allConstants(block) {
  return block.nodes.filter(n => n.type === IR_CONSTANT).map(n => n.props.value);
}

beforeEach(() => resetIRNodeIds());

describe("constantFolding", () => {
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
      const count = constantFolding(graph);
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
      constantFolding(graph);
      expect(ret.inputs[0].props.value).toBe(42);
    });

    it("folds Int32Mul with imul semantics", () => {
      const { graph, block } = makeGraph();
      const a = irConstant(0x7FFFFFFF);
      const b = irConstant(2);
      block.addNode(a);
      block.addNode(b);
      const mul = irInt32Mul(a, b);
      block.addNode(mul);
      const ret = irReturn(mul);
      block.addNode(ret);
      constantFolding(graph);
      expect(ret.inputs[0].props.value).toBe(Math.imul(0x7FFFFFFF, 2));
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
      expect(ret.inputs[0].props.value).toBe(-5);
    });

    it("cancels double negation", () => {
      const { graph, block } = makeGraph();
      const p = graph.addParameter(0);
      const neg1 = irNeg(p);
      block.addNode(neg1);
      const neg2 = irNeg(neg1);
      block.addNode(neg2);
      const ret = irReturn(neg2);
      block.addNode(ret);
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
      expect(ret.inputs[0]).toBe(not2);
    });
  });

  describe("identity elimination", () => {
    it("x + 0 => x", () => {
      const { graph, block } = makeGraph();
      const p = graph.addParameter(0);
      const zero = irConstant(0);
      block.addNode(zero);
      const add = irInt32Add(p, zero);
      block.addNode(add);
      const ret = irReturn(add);
      block.addNode(ret);
      constantFolding(graph);
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
      constantFolding(graph);
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
      constantFolding(graph);
      expect(ret.inputs[0]).toBe(p);
    });

    it("x * 0 => 0", () => {
      const { graph, block } = makeGraph();
      const p = graph.addParameter(0);
      const zero = irConstant(0);
      block.addNode(zero);
      const mul = irInt32Mul(p, zero);
      block.addNode(mul);
      const ret = irReturn(mul);
      block.addNode(ret);
      constantFolding(graph);
      expect(ret.inputs[0].type).toBe(IR_CONSTANT);
      expect(ret.inputs[0].props.value).toBe(0);
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
      constantFolding(graph);
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
      constantFolding(graph);
      expect(ret.inputs[0].type).toBe(IR_CONSTANT);
      expect(ret.inputs[0].props.value).toBe(0);
    });
  });
});

describe("constantPropagation", () => {
  it("propagates constant stored to local through load", () => {
    const { graph, block } = makeGraph();
    const c = irConstant(42);
    block.addNode(c);
    const store = irStoreLocal(0, c);
    block.addNode(store);
    const load = irLoadLocal(0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = constantPropagation(graph);
    expect(count).toBeGreaterThan(0);
    expect(ret.inputs[0].type).toBe(IR_CONSTANT);
    expect(ret.inputs[0].props.value).toBe(42);
  });

  it("does not propagate when local is overwritten with non-constant", () => {
    const { graph, block } = makeGraph();
    const c = irConstant(42);
    block.addNode(c);
    const store = irStoreLocal(0, c);
    block.addNode(store);
    const p = graph.addParameter(0);
    const store2 = irStoreLocal(0, p);
    block.addNode(store2);
    const load = irLoadLocal(0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = constantPropagation(graph);
    expect(ret.inputs[0]).toBe(load);
  });

  it("bypasses CheckSmi of constant integer", () => {
    const { graph, block } = makeGraph();
    const c = irConstant(5);
    block.addNode(c);
    const check = irCheckSmi(c);
    block.addNode(check);
    const add = irInt32Add(check, irConstant(1));
    block.addNode(add);
    const ret = irReturn(add);
    block.addNode(ret);
    const count = constantPropagation(graph);
    expect(count).toBeGreaterThan(0);
    expect(add.inputs[0]).toBe(c);
  });

  it("bypasses CheckNumber of constant number", () => {
    const { graph, block } = makeGraph();
    const c = irConstant(3.14);
    block.addNode(c);
    const check = irCheckNumber(c);
    block.addNode(check);
    const add = irFloat64Add(check, irConstant(1.0));
    block.addNode(add);
    const ret = irReturn(add);
    block.addNode(ret);
    const count = constantPropagation(graph);
    expect(count).toBeGreaterThan(0);
    expect(add.inputs[0]).toBe(c);
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
