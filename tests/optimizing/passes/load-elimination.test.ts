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
  IR_LOAD_FIELD,
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
