import { describe, it, expect, beforeEach } from "vitest";
import { escapeAnalysisAndScalarReplacement } from "../../../src/optimizing/passes/escape-analysis.js";
import { DominatorTree } from "../../../src/optimizing/analyses/dominance.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry, pointsToAnalysisId } from "../../../src/optimizing/analyses/index.js";
import { FrameState } from "../../../src/deopt/frame-state.js";
import { validateOptimizedGraph } from "../../../src/optimizing/validation/graph-validator.js";
import {
  CFGFunction,
  irConstant,
  irNewObject,
  irGenericGetIndex,
  irGenericSetIndex,
  irNewArray,
  irLoadArrayLength,
  irGenericSetProp,
  irGenericGetProp,
  irStoreField,
  irLoadField,
  irCheckMap,
  irGenericCall,
  irCheckSmi,
  irInt32Add,
  irReturn,
  irJump,
  irBranch,
  IR_NEW_OBJECT,
  IR_LOAD_FIELD,
  IR_STORE_FIELD,
  IR_PHI,
  IR_CONSTANT,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, connect, link } from "../../../src/optimizing/ir/cfg-edit.js";

beforeEach(() => resetIRNodeIds());

function runEscapeAnalysis(graph: CFGFunction): number {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return escapeAnalysisAndScalarReplacement(
    graph,
    new DominatorTree(graph),
    analyses.get(pointsToAnalysisId),
  );
}

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
    const count = runEscapeAnalysis(graph);
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
    const count = runEscapeAnalysis(graph);
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
    const count = runEscapeAnalysis(graph);
    expect(count).toBe(0);
    expect(block.nodes.some(n => n.type === IR_NEW_OBJECT)).toBe(true);
  });

  it("does NOT replace when an allocation has an unsupported alias use", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const value = irConstant(1);
    block.addNode(value);
    const alloc = irNewArray([value]);
    block.addNode(alloc);
    const length = irLoadArrayLength(alloc);
    block.addNode(length);
    const ret = irReturn(length);
    block.addNode(ret);
    const count = runEscapeAnalysis(graph);
    expect(count).toBe(0);
    expect(block.nodes.some(n => n === alloc)).toBe(true);
  });

  it("does NOT replace an array read past its last element", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const value = block.addNode(irConstant(1));
    const alloc = block.addNode(irNewArray([value]));
    const read = block.addNode(irGenericGetIndex(alloc, block.addNode(irConstant(3))));
    block.addNode(irReturn(read));

    expect(runEscapeAnalysis(graph)).toBe(0);
    expect(block.nodes).toContain(alloc);
  });

  it("does NOT replace an array written past its last element", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const value = block.addNode(irConstant(1));
    const alloc = block.addNode(irNewArray([value, value]));
    block.addNode(irGenericSetIndex(alloc, block.addNode(irConstant(2)), value));
    block.addNode(irReturn(value));

    expect(runEscapeAnalysis(graph)).toBe(0);
    expect(block.nodes).toContain(alloc);
  });

  it("still replaces an array read at its last element", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const value = block.addNode(irConstant(1));
    const alloc = block.addNode(irNewArray([value, value]));
    const read = block.addNode(irGenericGetIndex(alloc, block.addNode(irConstant(1))));
    block.addNode(irReturn(read));

    expect(runEscapeAnalysis(graph)).toBe(1);
    expect(block.nodes).not.toContain(alloc);
  });

  it("does NOT replace when object is returned (escapes)", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const ret = irReturn(alloc);
    block.addNode(ret);
    const count = runEscapeAnalysis(graph);
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
    const count = runEscapeAnalysis(graph);
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
    const count = runEscapeAnalysis(graph);
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
    link(b0, bTrue);
    link(b0, bFalse);
    b0.addNode(irBranch(cond, bTrue, bFalse));

    const val = irConstant(42);
    bTrue.addNode(val);
    const store = irStoreField(alloc, 0, val);
    bTrue.addNode(store);
    link(bTrue, bMerge);
    bTrue.addNode(irJump(bMerge));

    const load = irLoadField(alloc, 0);
    bFalse.addNode(load);
    link(bFalse, bMerge);
    bFalse.addNode(irJump(bMerge));

    const ret = irReturn(irConstant(0));
    bMerge.addNode(ret);

    runEscapeAnalysis(graph);

    expect(
      bFalse.nodes.some(n => n.type === IR_CONSTANT && n.props.value === 42),
    ).toBe(false);
    expect(bFalse.nodes).not.toContain(store);
    expect(
      bFalse.nodes.some(n => n.type === IR_CONSTANT && n.props.value === undefined),
    ).toBe(true);
  });

  it("does not scalar replace when a field load needs unsupported merge state", () => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();

    const alloc = irNewObject();
    const cond = irConstant(1);
    entry.addNode(alloc);
    entry.addNode(cond);
    link(entry, left);
    link(entry, right);
    entry.addNode(irBranch(cond, left, right));

    const leftValue = irConstant(11);
    left.addNode(leftValue);
    left.addNode(irStoreField(alloc, 0, leftValue));
    link(left, merge);
    left.addNode(irJump(merge));

    const rightValue = irConstant(12);
    right.addNode(rightValue);
    right.addNode(irStoreField(alloc, 0, rightValue));
    link(right, merge);
    right.addNode(irJump(merge));

    const load = irLoadField(alloc, 0);
    merge.addNode(load);
    const ret = irReturn(load);
    merge.addNode(ret);

    const count = runEscapeAnalysis(graph);

    expect(count).toBe(0);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_NEW_OBJECT)).toBe(true);
    expect(ret.inputs[0]).toBe(load);
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
    link(b0, b1);
    b0.addNode(irJump(b1));

    const load = irLoadField(alloc, 0);
    b1.addNode(load);
    const ret = irReturn(load);
    b1.addNode(ret);

    const count = runEscapeAnalysis(graph);
    expect(count).toBe(1);
    expect(ret.inputs[0].props.value).toBe(77);
  });

  it("does not scalar replace object phi when predecessor field state is not exact", () => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();

    const alloc = irNewObject();
    const value = irConstant(33);
    const cond = irConstant(1);
    entry.addNode(alloc);
    entry.addNode(value);
    entry.addNode(irStoreField(alloc, 0, value));
    entry.addNode(cond);
    link(entry, left);
    link(entry, right);
    entry.addNode(irBranch(cond, left, right));

    const obj = addPhi(merge, []);
    connect(left, merge, [alloc]);
    left.addNode(irJump(merge));
    connect(right, merge, [alloc]);
    right.addNode(irJump(merge));

    const load = irLoadField(obj, 0);
    merge.addNode(load);
    const ret = irReturn(load);
    merge.addNode(ret);

    const count = runEscapeAnalysis(graph);

    expect(count).toBe(0);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_NEW_OBJECT)).toBe(true);
    expect(ret.inputs[0]).toBe(load);
  });

  it("does not scalar replace generic property access through object phi", () => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const left = graph.addBlock();
    const right = graph.addBlock();
    const merge = graph.addBlock();

    const alloc = irNewObject();
    const value = irConstant(44);
    const cond = irConstant(1);
    entry.addNode(alloc);
    entry.addNode(value);
    entry.addNode(irGenericSetProp(alloc, "x", value));
    entry.addNode(cond);
    link(entry, left);
    link(entry, right);
    entry.addNode(irBranch(cond, left, right));

    const obj = addPhi(merge, []);
    connect(left, merge, [alloc]);
    left.addNode(irJump(merge));
    connect(right, merge, [alloc]);
    right.addNode(irJump(merge));

    const get = irGenericGetProp(obj, "x");
    merge.addNode(get);
    const ret = irReturn(get);
    merge.addNode(ret);

    const count = runEscapeAnalysis(graph);

    expect(count).toBe(0);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_NEW_OBJECT)).toBe(true);
    expect(ret.inputs[0]).toBe(get);
  });

  it("does not scalar replace allocations referenced by caller frame states", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    const allocFrame = new FrameState(null, 0);
    allocFrame.id = 0;
    alloc.frameState = allocFrame;
    block.addNode(alloc);
    const value = irConstant(55);
    block.addNode(value);
    block.addNode(irStoreField(alloc, 0, value));
    const load = irLoadField(alloc, 0);
    block.addNode(load);
    const ret = irReturn(load);
    const outer = new FrameState(null, 0);
    const caller = new FrameState(null, 0);
    outer.id = 1;
    caller.id = 2;
    caller.setLocal(0, alloc);
    outer.setCallerFrame(caller);
    ret.frameState = outer;
    block.addNode(ret);

    const count = runEscapeAnalysis(graph);

    expect(count).toBe(0);
    expect(caller.sunkAllocations).toBeNull();
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_NEW_OBJECT)).toBe(true);
    expect(ret.inputs[0]).toBe(load);
    validateOptimizedGraph(graph, [allocFrame, outer, caller]);
  });

  it("scalar replaces a loop-carried object field with a phi", () => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    const alloc = irNewObject();
    const initial = irConstant(0);
    entry.addNode(alloc);
    entry.addNode(initial);
    entry.addNode(irStoreField(alloc, 0, initial));
    link(entry, header);
    entry.addNode(irJump(header));

    const obj = addPhi(header, [alloc]);
    const current = irLoadField(obj, 0);
    const one = irConstant(1);
    const next = irInt32Add(current, one);
    const cond = irConstant(1);
    header.addNode(current);
    header.addNode(one);
    header.addNode(next);
    header.addNode(cond);
    link(header, body);
    link(header, exit);
    header.addNode(irBranch(cond, body, exit));

    body.addNode(irStoreField(obj, 0, next));
    link(body, header);
    body.addNode(irJump(header));
    connect(body, header, [obj]);

    const finalLoad = irLoadField(obj, 0);
    exit.addNode(finalLoad);
    const ret = irReturn(finalLoad);
    exit.addNode(ret);

    const count = runEscapeAnalysis(graph);

    expect(count).toBe(1);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_NEW_OBJECT)).toBe(false);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_LOAD_FIELD)).toBe(false);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_STORE_FIELD)).toBe(false);
    expect(header.phis).toHaveLength(1);
    expect(header.phis[0].type).toBe(IR_PHI);
    expect(header.phis[0].inputs).toContain(initial);
    expect(header.phis[0].inputs).toContain(next);
    expect(ret.inputs[0]).toBe(header.phis[0]);
  });

  it("scalar replaces loop-carried fields through identity map checks", () => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    const alloc = irNewObject();
    const initial = irConstant(0);
    entry.addNode(alloc);
    entry.addNode(initial);
    entry.addNode(irStoreField(alloc, 0, initial));
    link(entry, header);
    entry.addNode(irJump(header));

    const obj = addPhi(header, [alloc]);
    const checked = irCheckMap(obj, 1);
    const current = irLoadField(checked, 0);
    const one = irConstant(1);
    const next = irInt32Add(current, one);
    const cond = irConstant(1);
    header.addNode(checked);
    header.addNode(current);
    header.addNode(one);
    header.addNode(next);
    header.addNode(cond);
    link(header, body);
    link(header, exit);
    header.addNode(irBranch(cond, body, exit));

    body.addNode(irStoreField(checked, 0, next));
    link(body, header);
    body.addNode(irJump(header));
    connect(body, header, [obj]);

    const finalChecked = irCheckMap(obj, 1);
    const finalLoad = irLoadField(finalChecked, 0);
    exit.addNode(finalChecked);
    exit.addNode(finalLoad);
    const ret = irReturn(finalLoad);
    exit.addNode(ret);

    const count = runEscapeAnalysis(graph);

    expect(count).toBe(1);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_NEW_OBJECT)).toBe(false);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_LOAD_FIELD)).toBe(false);
    expect(graph.blocks.flatMap(block => block.nodes).some(n => n.type === IR_STORE_FIELD)).toBe(false);
    expect(ret.inputs[0]?.type).toBe(IR_PHI);
    expect(ret.inputs[0]?.inputs).toContain(initial);
    expect(ret.inputs[0]?.inputs).toContain(next);
  });

  it("keeps loop-carried field updates through numeric checks", () => {
    const graph = new CFGFunction("test");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    const alloc = irNewObject();
    const initial = irConstant(0);
    const one = irConstant(1);
    entry.addNode(alloc);
    entry.addNode(initial);
    entry.addNode(one);
    entry.addNode(irStoreField(alloc, 0, initial));
    link(entry, header);
    entry.addNode(irJump(header));

    const obj = addPhi(header, [alloc]);
    const cond = irConstant(1);
    header.addNode(cond);
    link(header, body);
    link(header, exit);
    header.addNode(irBranch(cond, body, exit));

    const checkedObj = irCheckMap(obj, 1);
    const current = irLoadField(checkedObj, 0);
    const checkedCurrent = irCheckSmi(current);
    const checkedOne = irCheckSmi(one);
    const next = irInt32Add(checkedCurrent, checkedOne);
    body.addNode(checkedObj);
    body.addNode(current);
    body.addNode(checkedCurrent);
    body.addNode(checkedOne);
    body.addNode(next);
    body.addNode(irStoreField(checkedObj, 0, next));
    connect(body, header, [obj]);
    body.addNode(irJump(header));

    const finalChecked = irCheckMap(obj, 1);
    const finalLoad = irLoadField(finalChecked, 0);
    exit.addNode(finalChecked);
    exit.addNode(finalLoad);
    const ret = irReturn(finalLoad);
    exit.addNode(ret);

    const count = runEscapeAnalysis(graph);

    expect(count).toBe(1);
    expect(ret.inputs[0]?.type).toBe(IR_PHI);
    expect(ret.inputs[0]?.inputs).toContain(initial);
    expect(ret.inputs[0]?.inputs).toContain(next);
  });
});
