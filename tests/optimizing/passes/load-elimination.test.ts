import { describe, it, expect, beforeEach } from "vitest";
import { loadElimination } from "../../../src/optimizing/passes/load-elimination.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry, modRefAnalysisId, pointsToAnalysisId } from "../../../src/optimizing/analyses/index.js";
import {
  CFGFunction,
  irConstant,
  irLoadField,
  irStoreField,
  irNewObject,
  irGenericCall,
  irGenericGetProp,
  irGenericSetProp,
  irInt32Add,
  irReturn,
  irJump,
  irBranch,
  irCheckArray,
  irCheckElementsKind,
  irLoadElement,
  IR_LOAD_FIELD,
  IR_LOAD_ELEMENT,
  IR_CONSTANT,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, connect, link } from "../../../src/optimizing/ir/cfg-edit.js";

beforeEach(() => resetIRNodeIds());

function eliminateLoads(graph: CFGFunction): number {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return loadElimination(
    graph,
    analyses.get(pointsToAnalysisId),
    analyses.get(modRefAnalysisId),
  );
}

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
    const count = eliminateLoads(graph);
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
    const count = eliminateLoads(graph);
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
    const count = eliminateLoads(graph);
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
    const count = eliminateLoads(graph);
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
    link(b0, b1);
    b0.addNode(irJump(b1));
    const load = irLoadField(obj, 0);
    b1.addNode(load);
    const ret = irReturn(load);
    b1.addNode(ret);
    const count = eliminateLoads(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val);
  });

  it("does not replace a loop-carried field load with the preheader store", () => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    const obj0 = irNewObject();
    const initial = irConstant(0);
    entry.addNode(obj0);
    entry.addNode(initial);
    entry.addNode(irStoreField(obj0, 0, initial));
    link(entry, header);
    entry.addNode(irJump(header));

    const obj = addPhi(header, [obj0]);
    const cond = irConstant(true);
    header.addNode(cond);
    link(header, body);
    link(header, exit);
    header.addNode(irBranch(cond, body, exit));

    const current = irLoadField(obj, 0);
    const one = irConstant(1);
    const next = irInt32Add(current, one);
    body.addNode(current);
    body.addNode(one);
    body.addNode(next);
    body.addNode(irStoreField(obj, 0, next));
    connect(body, header, [obj]);
    body.addNode(irJump(header));

    exit.addNode(irReturn(initial));

    const count = eliminateLoads(graph);

    expect(count).toBe(0);
    expect(next.inputs[0]).toBe(current);
    expect(body.nodes).toContain(current);
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
    const count = eliminateLoads(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val2);
  });

  it("invalidates local field state across generic property write", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = irNewObject();
    block.addNode(obj);
    const v1 = irConstant(1);
    const v2 = irConstant(2);
    block.addNode(v1);
    block.addNode(v2);
    block.addNode(irStoreField(obj, 0, v1));
    block.addNode(irGenericSetProp(obj, "x", v2));
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);

    const count = eliminateLoads(graph);

    expect(count).toBe(0);
    expect(ret.inputs[0]).toBe(load);
    expect(block.nodes).toContain(load);
  });

  it("invalidates local field state across generic property read", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = irNewObject();
    block.addNode(obj);
    const val = irConstant(1);
    block.addNode(val);
    block.addNode(irStoreField(obj, 0, val));
    block.addNode(irGenericGetProp(obj, "x"));
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);

    const count = eliminateLoads(graph);

    expect(count).toBe(0);
    expect(ret.inputs[0]).toBe(load);
    expect(block.nodes).toContain(load);
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
    const count = eliminateLoads(graph);
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
    call.props.declaredEffects = ["pure"];
    block.addNode(call);
    const load = irLoadField(obj, 0);
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);
    const count = eliminateLoads(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val);
  });

  it("eliminates load available from every branch at a merge", () => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();
    const obj = irNewObject();
    const cond = irConstant(true);
    const val = irConstant(7);
    entry.addNode(obj);
    entry.addNode(cond);
    entry.addNode(val);
    link(entry, left);
    link(entry, right);
    entry.addNode(irBranch(cond, left, right));
    left.addNode(irStoreField(obj, 0, val));
    link(left, merge);
    left.addNode(irJump(merge));
    right.addNode(irStoreField(obj, 0, val));
    link(right, merge);
    right.addNode(irJump(merge));
    const load = irLoadField(obj, 0);
    merge.addNode(load);
    const ret = irReturn(load);
    merge.addNode(ret);

    const count = eliminateLoads(graph);

    expect(count).toBe(1);
    expect(ret.inputs[0]).toBe(val);
  });

  it("keeps a load of a second array that only shares the first array's shape", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const left = graph.addParameter(0);
    const right = graph.addParameter(1);
    const index = irConstant(0);
    block.addNode(index);
    const leftElements = irCheckElementsKind(irCheckArray(left), "PACKED_SMI");
    block.addNode(leftElements.inputs[0]!);
    block.addNode(leftElements);
    const rightElements = irCheckElementsKind(irCheckArray(right), "PACKED_SMI");
    block.addNode(rightElements.inputs[0]!);
    block.addNode(rightElements);
    const leftLoad = irLoadElement(leftElements, index);
    block.addNode(leftLoad);
    const rightLoad = irLoadElement(rightElements, index);
    block.addNode(rightLoad);
    const ret = irReturn(irInt32Add(leftLoad, rightLoad));
    block.addNode(ret.inputs[0]!);
    block.addNode(ret);

    expect(eliminateLoads(graph)).toBe(0);
    expect(block.nodes.filter((n) => n.type === IR_LOAD_ELEMENT)).toHaveLength(2);
  });

  it("keeps a second load of one array taken at a different index", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const array = graph.addParameter(0);
    const first = graph.addParameter(1);
    const second = graph.addParameter(2);
    const elements = irCheckElementsKind(irCheckArray(array), "PACKED_SMI");
    block.addNode(elements.inputs[0]!);
    block.addNode(elements);
    const firstLoad = irLoadElement(elements, first);
    block.addNode(firstLoad);
    const secondLoad = irLoadElement(elements, second);
    block.addNode(secondLoad);
    const ret = irReturn(irInt32Add(firstLoad, secondLoad));
    block.addNode(ret.inputs[0]!);
    block.addNode(ret);

    expect(eliminateLoads(graph)).toBe(0);
    expect(block.nodes.filter((n) => n.type === IR_LOAD_ELEMENT)).toHaveLength(2);
  });

  it("still forwards a repeated load reached through a second guard on one array", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const array = graph.addParameter(0);
    const index = irConstant(0);
    block.addNode(index);
    const firstGuard = irCheckElementsKind(irCheckArray(array), "PACKED_SMI");
    block.addNode(firstGuard.inputs[0]!);
    block.addNode(firstGuard);
    const firstLoad = irLoadElement(firstGuard, index);
    block.addNode(firstLoad);
    const secondGuard = irCheckElementsKind(irCheckArray(array), "PACKED_SMI");
    block.addNode(secondGuard.inputs[0]!);
    block.addNode(secondGuard);
    const secondLoad = irLoadElement(secondGuard, index);
    block.addNode(secondLoad);
    const ret = irReturn(secondLoad);
    block.addNode(ret);

    expect(eliminateLoads(graph)).toBe(1);
    expect(ret.inputs[0]).toBe(firstLoad);
  });

  it("keeps a load of a second object that only shares the first object's shape", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const first = graph.addParameter(0);
    const second = graph.addParameter(1);
    const firstLoad = irLoadField(first, 0);
    block.addNode(firstLoad);
    const secondLoad = irLoadField(second, 0);
    block.addNode(secondLoad);
    const ret = irReturn(irInt32Add(firstLoad, secondLoad));
    block.addNode(ret.inputs[0]!);
    block.addNode(ret);

    expect(eliminateLoads(graph)).toBe(0);
    expect(block.nodes.filter((n) => n.type === IR_LOAD_FIELD)).toHaveLength(2);
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
    const count = eliminateLoads(graph);
    expect(count).toBe(0);
  });
});
