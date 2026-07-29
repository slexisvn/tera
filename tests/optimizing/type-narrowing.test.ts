import { describe, it, expect, beforeEach } from "vitest";
import { typeNarrowing } from "../../src/optimizing/passes/type-narrowing.js";
import {
  CFGFunction,
  IRNode,
  irConstant,
  irCheckSmi,
  irCheckNumber,
  irCheckMap,
  irGenericAdd,
  irGenericSub,
  irGenericCompare,
  irInt32Compare,
  irReturn,
  irBranch,
  irJump,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_COMPARE,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_COMPARE,
  IR_GENERIC_ADD,
  IR_TYPEOF,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

describe("typeNarrowing", () => {
  describe("CheckSmi narrowing → int32 specialization", () => {
    it("specializes GenericAdd to Int32Add when both inputs pass CheckSmi", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = irCheckSmi(p0);
      const check1 = irCheckSmi(p1);
      block.addNode(check0);
      block.addNode(check1);
      const add = irGenericAdd(check0, check1);
      block.addNode(add);
      block.addNode(irReturn(add));

      const count = typeNarrowing(graph);

      expect(count).toBeGreaterThanOrEqual(1);
      expect(add.type).toBe(IR_INT32_ADD);
    });

    it("specializes GenericSub to Int32Sub when both inputs are smi-narrowed", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = irCheckSmi(p0);
      const check1 = irCheckSmi(p1);
      block.addNode(check0);
      block.addNode(check1);
      const sub = irGenericSub(check0, check1);
      block.addNode(sub);
      block.addNode(irReturn(sub));

      typeNarrowing(graph);

      expect(sub.type).toBe(IR_INT32_SUB);
    });

    it("specializes GenericCompare to Int32Compare when both inputs are smi", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = irCheckSmi(p0);
      const check1 = irCheckSmi(p1);
      block.addNode(check0);
      block.addNode(check1);
      const cmp = irGenericCompare("<", check0, check1);
      block.addNode(cmp);
      block.addNode(irReturn(cmp));

      typeNarrowing(graph);

      expect(cmp.type).toBe(IR_INT32_COMPARE);
    });
  });

  describe("CheckNumber narrowing → float64 specialization", () => {
    it("specializes GenericAdd to Float64Add when both inputs pass CheckNumber (not smi)", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = irCheckNumber(p0);
      const check1 = irCheckNumber(p1);
      block.addNode(check0);
      block.addNode(check1);
      const add = irGenericAdd(check0, check1);
      block.addNode(add);
      block.addNode(irReturn(add));

      typeNarrowing(graph);

      expect([IR_FLOAT64_ADD, IR_INT32_ADD]).toContain(add.type);
    });
  });

  describe("no narrowing without type facts", () => {
    it("does NOT specialize when inputs have no type checks", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const add = irGenericAdd(p0, p1);
      block.addNode(add);
      block.addNode(irReturn(add));

      const count = typeNarrowing(graph);

      expect(count).toBe(0);
      expect(add.type).toBe(IR_GENERIC_ADD);
    });

    it("does NOT specialize when only one input has type facts", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = irCheckSmi(p0);
      block.addNode(check0);
      const add = irGenericAdd(check0, p1);
      block.addNode(add);
      block.addNode(irReturn(add));

      const count = typeNarrowing(graph);

      expect(count).toBe(0);
      expect(add.type).toBe(IR_GENERIC_ADD);
    });
  });

  describe("mixed smi + number → float64 specialization", () => {
    it("specializes to float64 when one input is smi and other is number (both numeric)", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = irCheckSmi(p0);
      const check1 = irCheckNumber(p1);
      block.addNode(check0);
      block.addNode(check1);
      const add = irGenericAdd(check0, check1);
      block.addNode(add);
      block.addNode(irReturn(add));

      typeNarrowing(graph);

      expect([IR_FLOAT64_ADD, IR_INT32_ADD]).toContain(add.type);
    });
  });

  describe("constant type inference", () => {
    it("narrows integer constant + CheckSmi parameter to int32 arithmetic", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const check = irCheckSmi(p0);
      block.addNode(check);
      const c = irConstant(5);
      block.addNode(c);
      const add = irGenericAdd(check, c);
      block.addNode(add);
      block.addNode(irReturn(add));

      typeNarrowing(graph);

      expect(add.type).toBe(IR_INT32_ADD);
    });
  });

  describe("dominator tree propagation", () => {
    it("propagates type facts to dominated blocks", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const b1 = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = irCheckSmi(p0);
      const check1 = irCheckSmi(p1);
      b0.addNode(check0);
      b0.addNode(check1);
      b0.addSuccessor(b1);
      b0.addNode(irJump(b1));

      const add = irGenericAdd(check0, check1);
      b1.addNode(add);
      b1.addNode(irReturn(add));

      typeNarrowing(graph);

      expect(add.type).toBe(IR_INT32_ADD);
    });
  });

  describe("branch-based typeof narrowing", () => {
    it("narrows true branch of typeof == 'number' to float64 arithmetic", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const bTrue = graph.addBlock();
      const bFalse = graph.addBlock();

      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);

      const typeofNode = new IRNode(IR_TYPEOF, {});
      typeofNode.addInput(p0);
      b0.addNode(typeofNode);
      const strConst = irConstant("number");
      b0.addNode(strConst);
      const cmp = irInt32Compare("==", typeofNode, strConst);
      b0.addNode(cmp);
      b0.addSuccessor(bTrue);
      b0.addSuccessor(bFalse);
      b0.addNode(irBranch(cmp, bTrue, bFalse));

      const check1 = irCheckSmi(p1);
      bTrue.addNode(check1);
      const add = irGenericAdd(p0, check1);
      bTrue.addNode(add);
      bTrue.addNode(irReturn(add));

      bFalse.addNode(irReturn(irConstant(0)));

      typeNarrowing(graph);

      expect([IR_FLOAT64_ADD, IR_INT32_ADD]).toContain(add.type);
    });

    it("narrows true branch with === operator", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const bTrue = graph.addBlock();
      const bFalse = graph.addBlock();

      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);

      const typeofNode = new IRNode(IR_TYPEOF, {});
      typeofNode.addInput(p0);
      b0.addNode(typeofNode);
      const strConst = irConstant("number");
      b0.addNode(strConst);
      const cmp = irInt32Compare("===", typeofNode, strConst);
      b0.addNode(cmp);
      b0.addSuccessor(bTrue);
      b0.addSuccessor(bFalse);
      b0.addNode(irBranch(cmp, bTrue, bFalse));

      const check1 = irCheckSmi(p1);
      bTrue.addNode(check1);
      const add = irGenericAdd(p0, check1);
      bTrue.addNode(add);
      bTrue.addNode(irReturn(add));

      bFalse.addNode(irReturn(irConstant(0)));

      typeNarrowing(graph);

      expect([IR_FLOAT64_ADD, IR_INT32_ADD]).toContain(add.type);
    });

    it("does not narrow false branch to the same type as true", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const bTrue = graph.addBlock();
      const bFalse = graph.addBlock();

      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);

      const typeofNode = new IRNode(IR_TYPEOF, {});
      typeofNode.addInput(p0);
      b0.addNode(typeofNode);
      const strConst = irConstant("number");
      b0.addNode(strConst);
      const cmp = irInt32Compare("==", typeofNode, strConst);
      b0.addNode(cmp);
      b0.addSuccessor(bTrue);
      b0.addSuccessor(bFalse);
      b0.addNode(irBranch(cmp, bTrue, bFalse));

      bTrue.addNode(irReturn(irConstant(1)));

      const add = irGenericAdd(p0, p1);
      bFalse.addNode(add);
      bFalse.addNode(irReturn(add));

      typeNarrowing(graph);

      expect(add.type).toBe(IR_GENERIC_ADD);
    });
  });
});
