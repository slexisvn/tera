import { describe, it, expect, beforeEach } from "vitest";
import {
  typeNarrowing,
  widenUnprovenInt32Arithmetic,
} from "../../../src/optimizing/passes/type-narrowing.js";
import { DominatorTree } from "../../../src/optimizing/analyses/dominance.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  CFGFunction,
  CFGInstruction,
  IRNode,
  irConstant,
  irCheckSmi,
  irCheckNumber,
  irCheckMap,
  irGenericAdd,
  irGenericSub,
  irGenericCall,
  irGenericCompare,
  irInt32Compare,
  irLoadGlobal,
  irReturn,
  irBranch,
  irJump,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_COMPARE,
  IR_FLOAT64_ADD,
  IR_GENERIC_ADD,
  IR_TYPEOF,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import { FrameState } from "../../../src/deopt/frame-state.js";
import { RANGE_BUILTIN } from "../../../src/optimizing/metadata/builtin-methods.js";

beforeEach(() => resetIRNodeIds());

function guarded<T extends { frameState: FrameState | null }>(check: T): T {
  check.frameState = new FrameState(null, 0);
  return check;
}

const checkSmi = (value: CFGInstruction) => guarded(irCheckSmi(value));
const checkNumber = (value: CFGInstruction) => guarded(irCheckNumber(value));
const checkMap = (value: CFGInstruction, mapId: number) => guarded(irCheckMap(value, mapId));

function narrowTypes(graph: CFGFunction): number {
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return typeNarrowing(
    graph,
    new DominatorTree(graph),
    analyses.get(typeInferenceAnalysisId),
  );
}

describe("typeNarrowing", () => {
  describe("CheckSmi narrowing → int32 specialization", () => {
    it("specializes GenericAdd to Int32Add when both inputs pass CheckSmi", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = checkSmi(p0);
      const check1 = checkSmi(p1);
      block.addNode(check0);
      block.addNode(check1);
      const add = irGenericAdd(check0, check1);
      block.addNode(add);
      block.addNode(irReturn(add));

      const count = narrowTypes(graph);

      expect(count).toBeGreaterThanOrEqual(1);
      expect(add.type).toBe(IR_INT32_ADD);
    });

    it("specializes GenericSub to Int32Sub when both inputs are smi-narrowed", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = checkSmi(p0);
      const check1 = checkSmi(p1);
      block.addNode(check0);
      block.addNode(check1);
      const sub = irGenericSub(check0, check1);
      block.addNode(sub);
      block.addNode(irReturn(sub));

      narrowTypes(graph);

      expect(sub.type).toBe(IR_INT32_SUB);
    });

    it("specializes GenericCompare to Int32Compare when both inputs are smi", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = checkSmi(p0);
      const check1 = checkSmi(p1);
      block.addNode(check0);
      block.addNode(check1);
      const cmp = irGenericCompare("<", check0, check1);
      block.addNode(cmp);
      block.addNode(irReturn(cmp));

      narrowTypes(graph);

      expect(cmp.type).toBe(IR_INT32_COMPARE);
    });
  });

  describe("CheckNumber narrowing → float64 specialization", () => {
    it("specializes GenericAdd to Float64Add when both inputs pass CheckNumber (not smi)", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = checkNumber(p0);
      const check1 = checkNumber(p1);
      block.addNode(check0);
      block.addNode(check1);
      const add = irGenericAdd(check0, check1);
      block.addNode(add);
      block.addNode(irReturn(add));

      narrowTypes(graph);

      expect(add.type).toBe(IR_FLOAT64_ADD);
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

      const count = narrowTypes(graph);

      expect(count).toBe(0);
      expect(add.type).toBe(IR_GENERIC_ADD);
    });

    it("does NOT specialize when only one input has type facts", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const check0 = checkSmi(p0);
      block.addNode(check0);
      const add = irGenericAdd(check0, p1);
      block.addNode(add);
      block.addNode(irReturn(add));

      const count = narrowTypes(graph);

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
      const check0 = checkSmi(p0);
      const check1 = checkNumber(p1);
      block.addNode(check0);
      block.addNode(check1);
      const add = irGenericAdd(check0, check1);
      block.addNode(add);
      block.addNode(irReturn(add));

      narrowTypes(graph);

      expect(add.type).toBe(IR_FLOAT64_ADD);
    });
  });

  describe("constant type inference", () => {
    it("narrows integer constant + CheckSmi parameter to int32 arithmetic", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const check = checkSmi(p0);
      block.addNode(check);
      const c = irConstant(5);
      block.addNode(c);
      const add = irGenericAdd(check, c);
      block.addNode(add);
      block.addNode(irReturn(add));

      narrowTypes(graph);

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
      const check0 = checkSmi(p0);
      const check1 = checkSmi(p1);
      b0.addNode(check0);
      b0.addNode(check1);
      link(b0, b1);
      b0.addNode(irJump(b1));

      const add = irGenericAdd(check0, check1);
      b1.addNode(add);
      b1.addNode(irReturn(add));

      narrowTypes(graph);

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
      link(b0, bTrue);
      link(b0, bFalse);
      b0.addNode(irBranch(cmp, bTrue, bFalse));

      const check1 = checkSmi(p1);
      bTrue.addNode(check1);
      const add = irGenericAdd(p0, check1);
      bTrue.addNode(add);
      bTrue.addNode(irReturn(add));

      bFalse.addNode(irReturn(irConstant(0)));

      narrowTypes(graph);

      expect(add.type).toBe(IR_FLOAT64_ADD);
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
      link(b0, bTrue);
      link(b0, bFalse);
      b0.addNode(irBranch(cmp, bTrue, bFalse));

      const check1 = checkSmi(p1);
      bTrue.addNode(check1);
      const add = irGenericAdd(p0, check1);
      bTrue.addNode(add);
      bTrue.addNode(irReturn(add));

      bFalse.addNode(irReturn(irConstant(0)));

      narrowTypes(graph);

      expect(add.type).toBe(IR_FLOAT64_ADD);
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
      link(b0, bTrue);
      link(b0, bFalse);
      b0.addNode(irBranch(cmp, bTrue, bFalse));

      bTrue.addNode(irReturn(irConstant(1)));

      const add = irGenericAdd(p0, p1);
      bFalse.addNode(add);
      bFalse.addNode(irReturn(add));

      narrowTypes(graph);

      expect(add.type).toBe(IR_GENERIC_ADD);
    });
  });

  describe("arithmetic that can leave int32", () => {
    function summing(returns: string): { graph: CFGFunction; add: CFGInstruction } {
      const graph = new CFGFunction("sum");
      graph.declaredSignature = { params: ["int", "int"], names: ["a", "b"], returns };
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const p1 = graph.addParameter(1);
      const add = irGenericAdd(p0, p1);
      block.addNode(add);
      block.addNode(irReturn(add));
      return { graph, add };
    }

    it("wraps in int32 when every reader of the sum truncates it", () => {
      const { graph, add } = summing("int");

      narrowTypes(graph);

      expect(add.type).toBe(IR_INT32_ADD);
      expect(add.props.noOverflow).toBe(true);
    });

    it("settles a sum a range counts with, whatever the function answers", () => {
      const graph = new CFGFunction("total");
      graph.declaredSignature = { params: ["int"], names: ["n"], returns: "float" };
      const block = graph.addBlock();
      const n = graph.addParameter(0);
      const one = block.addNode(irConstant(1));
      const add = block.addNode(irGenericAdd(n, one));
      const callee = block.addNode(irLoadGlobal(RANGE_BUILTIN));
      const counted = block.addNode(irGenericCall(callee, [one, add]));
      block.addNode(irReturn(counted));

      narrowTypes(graph);

      expect(add.type).toBe(IR_INT32_ADD);
      expect(add.props.noOverflow).toBe(true);
      expect(widenUnprovenInt32Arithmetic(graph)).toBe(0);
    });

    it("leaves the sum unproven when its reader keeps the whole number", () => {
      const { graph, add } = summing("float");

      narrowTypes(graph);

      expect(add.type).toBe(IR_INT32_ADD);
      expect(add.props.noOverflow).toBeUndefined();
    });

    it("answers a double for an unproven sum nothing can deoptimize", () => {
      const { graph, add } = summing("float");
      narrowTypes(graph);

      expect(widenUnprovenInt32Arithmetic(graph)).toBe(1);
      expect(add.type).toBe(IR_FLOAT64_ADD);
    });

    it("keeps a sum a bounds proof settled", () => {
      const { graph, add } = summing("float");
      narrowTypes(graph);
      add.props.noOverflow = true;

      expect(widenUnprovenInt32Arithmetic(graph)).toBe(0);
      expect(add.type).toBe(IR_INT32_ADD);
    });
  });
  describe("comparing against null", () => {
    function comparing(declared: string, guard: boolean) {
      const graph = new CFGFunction("test");
      graph.declaredSignature = { params: [declared], returns: "bool" };
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const value = guard ? checkSmi(p0) : p0;
      if (guard) block.addNode(value);
      const absent = irConstant(null);
      block.addNode(absent);
      const compare = irGenericCompare("==", value, absent);
      block.addNode(compare);
      block.addNode(irReturn(compare));
      return { graph, compare };
    }

    it("folds it away when the value is declared as one that cannot be null", () => {
      const { graph, compare } = comparing("int", false);
      narrowTypes(graph);

      expect(compare.block).toBeNull();
    });

    it("keeps it when the value is declared as one that can be null", () => {
      const { graph, compare } = comparing("int | null", false);
      narrowTypes(graph);

      expect(compare.block).not.toBeNull();
    });

    it("keeps it when only a speculation says the value cannot be null", () => {
      const { graph, compare } = comparing("int | null", true);
      narrowTypes(graph);

      expect(compare.block).not.toBeNull();
    });
  });
});
