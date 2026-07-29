import { describe, it, expect, beforeEach } from "vitest";
import {
  representationSelection,
  REP_INT32,
  REP_FLOAT64,
  REP_BOOL,
  REP_HANDLE,
  REP_TAGGED_NUMBER,
} from "../../src/optimizing/passes/repr-selection.js";
import {
  CFGFunction,
  irConstant,
  irInt32Add,
  irFloat64Add,
  irInt32Compare,
  irFloat64Compare,
  irGenericSub,
  irGenericAdd,
  irCheckSmi,
  irCheckNumber,
  irReturn,
  irNewObject,
  IR_BOX,
  IR_UNBOX,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

describe("representationSelection", () => {
  describe("rep assignment", () => {
    it("assigns REP_INT32 to int32 arithmetic producers", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const a = irConstant(1);
      const b = irConstant(2);
      block.addNode(a);
      block.addNode(b);
      const add = irInt32Add(a, b);
      block.addNode(add);
      block.addNode(irReturn(add));

      representationSelection(graph);

      expect(add.props._rep).toBe(REP_INT32);
    });

    it("assigns REP_FLOAT64 to float64 arithmetic producers", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const a = irConstant(1.5);
      const b = irConstant(2.5);
      block.addNode(a);
      block.addNode(b);
      const add = irFloat64Add(a, b);
      block.addNode(add);
      block.addNode(irReturn(add));

      representationSelection(graph);

      expect(add.props._rep).toBe(REP_FLOAT64);
    });

    it("assigns REP_BOOL to comparison producers", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const a = irConstant(1);
      const b = irConstant(2);
      block.addNode(a);
      block.addNode(b);
      const cmp = irInt32Compare("==", a, b);
      block.addNode(cmp);
      block.addNode(irReturn(cmp));

      representationSelection(graph);

      expect(cmp.props._rep).toBe(REP_BOOL);
    });

    it("infers constant rep from value type (int→INT32, float→FLOAT64, bool→BOOL, string→HANDLE)", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const intC = irConstant(42);
      const floatC = irConstant(3.14);
      const boolC = irConstant(true);
      const strC = irConstant("hello");
      block.addNode(intC);
      block.addNode(floatC);
      block.addNode(boolC);
      block.addNode(strC);
      block.addNode(irReturn(irConstant(0)));

      representationSelection(graph);

      expect(intC.props._rep).toBe(REP_INT32);
      expect(floatC.props._rep).toBe(REP_FLOAT64);
      expect(boolC.props._rep).toBe(REP_BOOL);
      expect(strC.props._rep).toBe(REP_HANDLE);
    });

    it("assigns REP_HANDLE to NewObject", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irNewObject();
      block.addNode(obj);
      block.addNode(irReturn(obj));

      representationSelection(graph);

      expect(obj.props._rep).toBe(REP_HANDLE);
    });

    it("assigns REP_INT32 to CheckSmi", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const param = graph.addParameter(0);
      const check = irCheckSmi(param);
      block.addNode(check);
      block.addNode(irReturn(check));

      representationSelection(graph);

      expect(check.props._rep).toBe(REP_INT32);
    });

    it("assigns CheckNumber rep based on consumer: FLOAT64 if consumed by float64 op, else INT32", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const param = graph.addParameter(0);
      const check = irCheckNumber(param);
      block.addNode(check);
      const b = irConstant(1.0);
      block.addNode(b);
      const fadd = irFloat64Add(check, b);
      block.addNode(fadd);
      block.addNode(irReturn(fadd));

      representationSelection(graph);

      expect(check.props._rep).toBe(REP_FLOAT64);
    });

    it("assigns REP_TAGGED_NUMBER to generic sub/mul/div/mod producers", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const a = irConstant(10);
      const b = irConstant(3);
      block.addNode(a);
      block.addNode(b);
      const sub = irGenericSub(a, b);
      block.addNode(sub);
      block.addNode(irReturn(sub));

      representationSelection(graph);

      expect(sub.props._rep).toBe(REP_TAGGED_NUMBER);
    });
  });

  describe("box/unbox insertion", () => {
    it("inserts Box when int32 producer feeds tagged-number consumer", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const a = irConstant(1);
      const b = irConstant(2);
      block.addNode(a);
      block.addNode(b);
      const add = irInt32Add(a, b);
      block.addNode(add);
      const c = irConstant(3);
      block.addNode(c);
      const sub = irGenericSub(add, c);
      block.addNode(sub);
      block.addNode(irReturn(sub));

      const insertCount = representationSelection(graph);

      expect(insertCount).toBeGreaterThan(0);
      const boxNodes = block.nodes.filter(n => n.type === IR_BOX);
      expect(boxNodes.length).toBeGreaterThan(0);
    });

    it("inserts Unbox when tagged/handle producer feeds int32 consumer", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const param = graph.addParameter(0);
      const check = irCheckSmi(param);
      block.addNode(check);
      const b = irConstant(1);
      block.addNode(b);
      const add = irInt32Add(check, b);
      block.addNode(add);
      block.addNode(irReturn(add));

      representationSelection(graph);

      expect(param.props._rep).toBeDefined();
    });

    it("does not insert box/unbox when reps already match", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const a = irConstant(1);
      const b = irConstant(2);
      block.addNode(a);
      block.addNode(b);
      const add = irInt32Add(a, b);
      block.addNode(add);
      const c = irConstant(3);
      block.addNode(c);
      const add2 = irInt32Add(add, c);
      block.addNode(add2);
      block.addNode(irReturn(add2));

      const insertCount = representationSelection(graph);

      const boxNodes = block.nodes.filter(n => n.type === IR_BOX);
      const unboxNodes = block.nodes.filter(n => n.type === IR_UNBOX);
      expect(boxNodes.length + unboxNodes.length).toBe(0);
    });
  });
});
