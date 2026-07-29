import { describe, it, expect, beforeEach } from "vitest";
import { loadElimination } from "../../src/optimizing/passes/load-elimination.js";
import {
  CFGFunction,
  irConstant,
  irLoadField,
  irStoreField,
  irNewObject,
  irGenericCall,
  irGenericSetProp,
  irReturn,
  irJump,
  IR_LOAD_FIELD,
  IR_CONSTANT,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

describe("loadElimination", () => {
  it("eliminates load after store to same object and offset", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = irNewObject();
    block.addNode(obj);
    const val = irConstant(42);
    block.addNode(val);
    const store = irStoreField(obj, 0, val);
    block.addNode(store);
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val);
    expect(block.nodes.every(n => n.type !== IR_LOAD_FIELD)).toBe(true);
  });

  it("does not eliminate load of different offset", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = irNewObject();
    block.addNode(obj);
    const val = irConstant(42);
    block.addNode(val);
    const store = irStoreField(obj, 0, val);
    block.addNode(store);
    const load = irLoadField(obj, 4);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(0);
  });

  it("invalidates state after call for escaped objects", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = graph.addParameter(0);
    const val = irConstant(42);
    block.addNode(val);
    const store = irStoreField(obj, 0, val);
    block.addNode(store);
    const callee = irConstant("fn");
    block.addNode(callee);
    const call = irGenericCall(callee, []);
    block.addNode(call);
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(0);
  });

  it("preserves state for fresh non-escaped allocation after call", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = irNewObject();
    block.addNode(obj);
    const val = irConstant(42);
    block.addNode(val);
    const store = irStoreField(obj, 0, val);
    block.addNode(store);
    const callee = irConstant("fn");
    block.addNode(callee);
    const call = irGenericCall(callee, []);
    block.addNode(call);
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val);
  });

  it("eliminates redundant load in dominated block", () => {
    const graph = new CFGFunction("test");
    const b0 = graph.addBlock();
    const b1 = graph.addBlock();
    const obj = irNewObject();
    b0.addNode(obj);
    const val = irConstant(10);
    b0.addNode(val);
    const store = irStoreField(obj, 0, val);
    b0.addNode(store);
    b0.addSuccessor(b1);
    b0.addNode(irJump(b1));
    const load = irLoadField(obj, 0);
    b1.addNode(load);
    const ret = irReturn(load);
    b1.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val);
  });

  it("store overwrites previous store state", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = irNewObject();
    block.addNode(obj);
    const val1 = irConstant(1);
    const val2 = irConstant(2);
    block.addNode(val1);
    block.addNode(val2);
    const store1 = irStoreField(obj, 0, val1);
    block.addNode(store1);
    const store2 = irStoreField(obj, 0, val2);
    block.addNode(store2);
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val2);
  });

  it("two fresh allocations are no-alias", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj1 = irNewObject();
    const obj2 = irNewObject();
    block.addNode(obj1);
    block.addNode(obj2);
    const val = irConstant(42);
    block.addNode(val);
    const store = irStoreField(obj1, 0, val);
    block.addNode(store);
    const storeOther = irStoreField(obj2, 0, irConstant(99));
    block.addNode(storeOther);
    const load = irLoadField(obj1, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val);
  });

  it("preserves load state across pure call", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = graph.addParameter(0);
    const val = irConstant(42);
    block.addNode(val);
    const store = irStoreField(obj, 0, val);
    block.addNode(store);
    const callee = irConstant("pureBuiltin");
    block.addNode(callee);
    const call = irGenericCall(callee, []);
    call.props.pure = true;
    block.addNode(call);
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val);
  });

  it("invalidates load state across non-pure call for non-fresh objects", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = graph.addParameter(0);
    const val = irConstant(42);
    block.addNode(val);
    const store = irStoreField(obj, 0, val);
    block.addNode(store);
    const callee = irConstant("fn");
    block.addNode(callee);
    const call = irGenericCall(callee, []);
    block.addNode(call);
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = loadElimination(graph);
    expect(count).toBe(0);
  });
});
