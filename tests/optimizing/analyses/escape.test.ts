import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irGenericSetProp,
  irJump,
  irLoadField,
  irNewObject,
  irReturn,
  irStoreField,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link, connect, addPhi } from "../../../src/optimizing/ir/cfg-edit.js";
import { analyzeEscapes } from "../../../src/optimizing/analyses/escape.js";

beforeEach(() => resetIRNodeIds());

describe("analyzeEscapes", () => {
  it("classifies a non-escaping object with property access as virtual", () => {
    const graph = new CFGFunction("simple");
    const block = graph.addBlock();
    const alloc = irNewObject();
    const val = irConstant(42);
    const set = irGenericSetProp(alloc, "x", val);
    const get = irGenericGetProp(alloc, "x");
    block.addNode(alloc);
    block.addNode(val);
    block.addNode(set);
    block.addNode(get);
    block.addNode(irReturn(get));

    const escape = analyzeEscapes(graph);
    expect(escape.escapes(alloc.id)).toBe(false);
    expect(escape.virtualAllocations()).toContain(alloc.id);
    expect(escape.aliasesOf(alloc.id)).toEqual([alloc]);
    expect(escape.receiverUsesOf(alloc.id)).toEqual(expect.arrayContaining([set, get]));
    expect(escape.flowsThroughPhi(alloc.id)).toBe(false);
  });

  it("marks an object passed to a call as escaping", () => {
    const graph = new CFGFunction("callEscape");
    const block = graph.addBlock();
    const alloc = irNewObject();
    const callee = irConstant("fn");
    const call = irGenericCall(callee, [alloc]);
    block.addNode(alloc);
    block.addNode(callee);
    block.addNode(call);
    block.addNode(irReturn(irConstant(0)));

    const escape = analyzeEscapes(graph);
    expect(escape.escapes(alloc.id)).toBe(true);
    expect(escape.virtualAllocations()).not.toContain(alloc.id);
  });

  it("marks a returned object as escaping", () => {
    const graph = new CFGFunction("returnEscape");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    block.addNode(irReturn(alloc));

    expect(analyzeEscapes(graph).escapes(alloc.id)).toBe(true);
  });

  it("escapes an object stored as a value into another object but keeps the container virtual", () => {
    const graph = new CFGFunction("nested");
    const block = graph.addBlock();
    const inner = irNewObject();
    const outer = irNewObject();
    const store = irStoreField(outer, 0, inner);
    block.addNode(inner);
    block.addNode(outer);
    block.addNode(store);
    block.addNode(irReturn(irConstant(0)));

    const escape = analyzeEscapes(graph);
    expect(escape.escapes(inner.id)).toBe(true);
    expect(escape.escapes(outer.id)).toBe(false);
  });

  it("keeps a loop-carried object virtual and records it flowing through a phi", () => {
    const graph = new CFGFunction("loopObject");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();

    const alloc = irNewObject();
    entry.addNode(alloc);
    entry.addNode(irJump(header));
    link(entry, header);

    const obj = addPhi(header, [alloc]);
    const load = irLoadField(obj, 0);
    const cond = irConstant(1);
    header.addNode(load);
    header.addNode(cond);
    header.addNode(irBranch(cond, body, exit));
    link(header, body);
    link(header, exit);

    const stored = irConstant(7);
    const store = irStoreField(obj, 0, stored);
    body.addNode(stored);
    body.addNode(store);
    body.addNode(irJump(header));
    connect(body, header, [obj]);

    exit.addNode(irReturn(irConstant(0)));

    const escape = analyzeEscapes(graph);
    expect(escape.escapes(alloc.id)).toBe(false);
    expect(escape.flowsThroughPhi(alloc.id)).toBe(true);
    const aliasIds = escape.aliasesOf(alloc.id).map((v) => v.id);
    expect(aliasIds).toContain(alloc.id);
    expect(aliasIds).toContain(obj.id);
    expect(escape.receiverUsesOf(alloc.id)).toEqual(expect.arrayContaining([load, store]));
  });

  it("escapes an object that merges with a non-object at a phi", () => {
    const graph = new CFGFunction("mixedPhi");
    const entry = graph.addBlock();
    const whenTrue = graph.addBlock();
    const whenFalse = graph.addBlock();
    const merge = graph.addBlock();

    const alloc = irNewObject();
    const other = irConstant(5);
    const cond = irConstant(1);
    entry.addNode(alloc);
    entry.addNode(other);
    entry.addNode(cond);
    entry.addNode(irBranch(cond, whenTrue, whenFalse));
    link(entry, whenTrue);
    link(entry, whenFalse);

    const merged = addPhi(merge, []);
    whenTrue.addNode(irJump(merge));
    connect(whenTrue, merge, [alloc]);
    whenFalse.addNode(irJump(merge));
    connect(whenFalse, merge, [other]);
    merge.addNode(irReturn(merged));

    const escape = analyzeEscapes(graph);
    expect(escape.originOf(merged).kind).toBe("top");
    expect(escape.escapes(alloc.id)).toBe(true);
  });
});
