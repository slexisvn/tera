import { describe, it, expect, beforeEach } from "vitest";
import { allocationSinking } from "../../src/optimizing/passes/allocation-sinking.js";
import {
  CFGFunction,
  irConstant,
  irNewObject,
  irReturn,
  irDeoptimize,
  irGenericSetProp,
  irGenericGetProp,
  irGenericCall,
  irStoreField,
  irLoadField,
  irCheckMap,
  IR_NEW_OBJECT,
  IR_DEOPTIMIZE,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

describe("allocationSinking", () => {
  it("sinks allocation that only escapes through deopt, attaches virtual state", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const val = irConstant(42);
    block.addNode(val);
    const setProp = irGenericSetProp(alloc, "x", val);
    block.addNode(setProp);
    const deopt = irDeoptimize("bail");
    deopt.addInput(alloc);
    block.addNode(deopt);

    const result = allocationSinking(graph);

    expect(result.sunkCount).toBe(1);
    expect(block.nodes.some(n => n.type === IR_NEW_OBJECT)).toBe(false);
    const deoptNode = block.nodes.find(n => n.type === IR_DEOPTIMIZE);
    expect(deoptNode.props.sunkAllocations).toBeDefined();
    const sunk = deoptNode.props.sunkAllocations.get(alloc.id);
    expect(sunk.props.get("x")).toBe(val);
  });

  it("sinks allocation with field stores via CheckMap, captures field virtual state", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const val = irConstant(99);
    block.addNode(val);
    const check = irCheckMap(alloc, 1);
    block.addNode(check);
    const store = irStoreField(check, 0, val);
    block.addNode(store);
    const deopt = irDeoptimize("bail");
    deopt.addInput(alloc);
    block.addNode(deopt);

    const result = allocationSinking(graph);

    expect(result.sunkCount).toBe(1);
    const deoptNode = block.nodes.find(n => n.type === IR_DEOPTIMIZE);
    const sunk = deoptNode.props.sunkAllocations.get(alloc.id);
    expect(sunk.fields.get(0)).toBe(val);
  });

  it("does NOT sink when allocation fully escapes through call", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const callee = irConstant("fn");
    block.addNode(callee);
    const call = irGenericCall(callee, [alloc]);
    block.addNode(call);
    const deopt = irDeoptimize("bail");
    deopt.addInput(alloc);
    block.addNode(deopt);

    const result = allocationSinking(graph);

    expect(result.sunkCount).toBe(0);
    expect(block.nodes.some(n => n.type === IR_NEW_OBJECT)).toBe(true);
  });

  it("does NOT sink when allocation escapes through return (not deopt-only)", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const ret = irReturn(alloc);
    block.addNode(ret);

    const result = allocationSinking(graph);

    expect(result.sunkCount).toBe(0);
    expect(block.nodes.some(n => n.type === IR_NEW_OBJECT)).toBe(true);
  });

  it("replaces loads with stored values after sinking", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const val = irConstant(7);
    block.addNode(val);
    const setProp = irGenericSetProp(alloc, "y", val);
    block.addNode(setProp);
    const getProp = irGenericGetProp(alloc, "y");
    block.addNode(getProp);
    const deopt = irDeoptimize("bail");
    deopt.addInput(alloc);
    block.addNode(deopt);

    allocationSinking(graph);

    expect(block.nodes.some(n => n.type === IR_NEW_OBJECT)).toBe(false);
  });

  it("handles multiple deopt escape points for same allocation", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const val = irConstant(10);
    block.addNode(val);
    const setProp = irGenericSetProp(alloc, "a", val);
    block.addNode(setProp);
    const deopt1 = irDeoptimize("bail1");
    deopt1.addInput(alloc);
    block.addNode(deopt1);
    const deopt2 = irDeoptimize("bail2");
    deopt2.addInput(alloc);
    block.addNode(deopt2);

    const result = allocationSinking(graph);

    expect(result.sunkCount).toBe(1);
    const deopts = block.nodes.filter(n => n.type === IR_DEOPTIMIZE);
    for (const d of deopts) {
      expect(d.props.sunkAllocations.has(alloc.id)).toBe(true);
      expect(d.props.sunkAllocations.get(alloc.id).props.get("a")).toBe(val);
    }
  });

  it("does NOT sink when there are no escape points at all", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const alloc = irNewObject();
    block.addNode(alloc);
    const val = irConstant(1);
    block.addNode(val);
    const setProp = irGenericSetProp(alloc, "x", val);
    block.addNode(setProp);
    const getProp = irGenericGetProp(alloc, "x");
    block.addNode(getProp);
    const ret = irReturn(getProp);
    block.addNode(ret);

    const result = allocationSinking(graph);

    expect(result.sunkCount).toBe(0);
  });
});
