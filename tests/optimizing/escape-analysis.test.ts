import { describe, it, expect, beforeEach } from "vitest";
import { escapeAnalysisAndScalarReplacement } from "../../src/optimizing/passes/escape-analysis.js";
import {
  CFGFunction,
  irConstant,
  irNewObject,
  irNewArray,
  irGenericSetProp,
  irGenericGetProp,
  irStoreField,
  irLoadField,
  irGenericCall,
  irInt32Add,
  irReturn,
  irJump,
  irBranch,
  IR_NEW_OBJECT,
  IR_GENERIC_SET_PROP,
  IR_GENERIC_GET_PROP,
  IR_STORE_FIELD,
  IR_LOAD_FIELD,
  IR_CONSTANT,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

describe("escapeAnalysisAndScalarReplacement", () => {
  it("scalar replaces non-escaping object with property access", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const val = irConstant(42);
    block.addNode(val);
    const set = irGenericSetProp(alloc, "x", val);
    block.addNode(set);
    const get = irGenericGetProp(alloc, "x");
    block.addNode(get);
    const ret = irReturn(get);
    block.addNode(ret);
    const count = escapeAnalysisAndScalarReplacement(graph);
    expect(count).toBe(1);
    expect(block.nodes.some(n => n.type === IR_NEW_OBJECT)).toBe(false);
    expect(ret.inputs[0].type).toBe(IR_CONSTANT);
    expect(ret.inputs[0].props.value).toBe(42);
  });

  it("scalar replaces non-escaping object with field access", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const val = irConstant(99);
    block.addNode(val);
    const store = irStoreField(alloc, 0, val);
    block.addNode(store);
    const load = irLoadField(alloc, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = escapeAnalysisAndScalarReplacement(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0].props.value).toBe(99);
  });

  it("does NOT replace when object escapes through call", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const callee = irConstant("fn");
    block.addNode(callee);
    const call = irGenericCall(callee, [alloc]);
    block.addNode(call);
    const ret = irReturn(irConstant(0));
    block.addNode(ret);
    const count = escapeAnalysisAndScalarReplacement(graph);
    expect(count).toBe(0);
    expect(block.nodes.some(n => n.type === IR_NEW_OBJECT)).toBe(true);
  });

  it("does NOT replace when object is returned (escapes)", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const ret = irReturn(alloc);
    block.addNode(ret);
    const count = escapeAnalysisAndScalarReplacement(graph);
    expect(count).toBe(0);
  });

  it("inserts undefined for uninitialized property read", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const get = irGenericGetProp(alloc, "y");
    block.addNode(get);
    const ret = irReturn(get);
    block.addNode(ret);
    const count = escapeAnalysisAndScalarReplacement(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0].type).toBe(IR_CONSTANT);
    expect(ret.inputs[0].props.value).toBeUndefined();
  });

  it("handles multiple properties on same object", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const v1 = irConstant(10);
    const v2 = irConstant(20);
    block.addNode(v1);
    block.addNode(v2);
    const set1 = irGenericSetProp(alloc, "a", v1);
    block.addNode(set1);
    const set2 = irGenericSetProp(alloc, "b", v2);
    block.addNode(set2);
    const get1 = irGenericGetProp(alloc, "a");
    block.addNode(get1);
    const get2 = irGenericGetProp(alloc, "b");
    block.addNode(get2);
    const sum = irInt32Add(get1, get2);
    block.addNode(sum);
    const ret = irReturn(sum);
    block.addNode(ret);
    const count = escapeAnalysisAndScalarReplacement(graph);
    expect(count).toBe(1);
  });

  it("does not leak store from sibling block in diamond CFG", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const bTrue = graph.addBlock();
    const bFalse = graph.addBlock();
    const bMerge = graph.addBlock();

    const alloc = irNewObject();
    b0.addNode(alloc);
    const cond = irConstant(1);
    b0.addNode(cond);
    b0.addSuccessor(bTrue);
    b0.addSuccessor(bFalse);
    b0.addNode(irBranch(cond, bTrue, bFalse));

    const val = irConstant(42);
    bTrue.addNode(val);
    const store = irStoreField(alloc, 0, val);
    bTrue.addNode(store);
    bTrue.addSuccessor(bMerge);
    bTrue.addNode(irJump(bMerge));

    const load = irLoadField(alloc, 0);
    bFalse.addNode(load);
    bFalse.addSuccessor(bMerge);
    bFalse.addNode(irJump(bMerge));

    const ret = irReturn(irConstant(0));
    bMerge.addNode(ret);

    escapeAnalysisAndScalarReplacement(graph);
    const falseHasLoad = bFalse.nodes.some(n => n.type === IR_LOAD_FIELD);
    const falseHasUndefined = bFalse.nodes.some(n => n.type === IR_CONSTANT && n.props.value === undefined);
    expect(falseHasLoad || falseHasUndefined).toBe(true);
  });

  it("propagates store to dominated block correctly", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();

    const alloc = irNewObject();
    b0.addNode(alloc);
    const val = irConstant(77);
    b0.addNode(val);
    const store = irStoreField(alloc, 0, val);
    b0.addNode(store);
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));

    const load = irLoadField(alloc, 0);
    b1.addNode(load);
    const ret = irReturn(load);
    b1.addNode(ret);

    const count = escapeAnalysisAndScalarReplacement(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0].props.value).toBe(77);
  });
});
