import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  CFGInstruction,
  irConstant,
  irInt32Add,
  irJump,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link, addPhi } from "../../../src/optimizing/ir/cfg-edit.js";
import { GraphEditor } from "../../../src/optimizing/ir/editor.js";

function frameStateNaming(value: CFGInstruction) {
  return {
    localValues: new Map([[0, value]]),
    stackValues: [],
    thisValue: null,
    callerFrameState: null,
  } as unknown as CFGInstruction["frameState"];
}

beforeEach(() => resetIRNodeIds());

function usesById(graph: CFGFunction): Map<number, number[]> {
  const snapshot = new Map<number, number[]>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      snapshot.set(node.id, node.uses.map((use) => use.id).sort((a, b) => a - b));
    }
  }
  return snapshot;
}

describe("GraphEditor.replaceAllUses", () => {
  it("rewrites every input occurrence and updates the use-lists", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const one = irConstant(1);
    const two = irConstant(2);
    const add = irInt32Add(one, one);
    block.addNode(one);
    block.addNode(two);
    block.addNode(add);

    new GraphEditor(graph).replaceAllUses(one, two);

    expect(add.inputs).toEqual([two, two]);
    expect(one.uses).toEqual([]);
    expect(two.uses).toEqual([add, add]);
  });

  it("leaves the use-lists identical to a full rebuild", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const one = irConstant(1);
    const two = irConstant(2);
    const add = irInt32Add(one, two);
    block.addNode(one);
    block.addNode(two);
    block.addNode(add);

    new GraphEditor(graph).replaceAllUses(one, two);

    const incremental = usesById(graph);
    graph.rebuildUses();
    expect(incremental).toEqual(usesById(graph));
  });

  it("rewrites phi inputs", () => {
    const graph = new CFGFunction("t");
    const head = graph.addBlock();
    const tail = graph.addBlock();
    const one = irConstant(1);
    const two = irConstant(2);
    head.addNode(one);
    head.addNode(two);
    head.addNode(irJump(tail));
    link(head, tail);
    const phi = addPhi(tail, [one]);

    new GraphEditor(graph).replaceAllUses(one, two);

    expect(phi.inputs).toEqual([two]);
  });

  it("does nothing when a node is replaced with itself", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const one = irConstant(1);
    const add = irInt32Add(one, one);
    block.addNode(one);
    block.addNode(add);

    new GraphEditor(graph).replaceAllUses(one, one);
    expect(add.inputs).toEqual([one, one]);
    expect(one.uses).toEqual([add, add]);
  });
});

describe("GraphEditor structural edits", () => {
  it("removes a node, detaching it from its inputs and its block", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const one = irConstant(1);
    const two = irConstant(2);
    const add = irInt32Add(one, two);
    block.addNode(one);
    block.addNode(two);
    block.addNode(add);

    new GraphEditor(graph).remove(add);

    expect(block.nodes).not.toContain(add);
    expect(one.uses).toEqual([]);
    expect(two.uses).toEqual([]);
    expect(add.block).toBeNull();
  });

  it("clears the block terminator when the terminator is removed", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const value = irConstant(1);
    const ret = new CFGInstruction("Return");
    ret.addInput(value);
    block.addNode(value);
    block.addNode(ret);
    expect(block.terminator).toBe(ret);

    new GraphEditor(graph).remove(ret);
    expect(block.terminator).toBeNull();
  });

  it("inserts before and after an anchor in program order", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const anchor = irConstant(0);
    block.addNode(anchor);
    const editor = new GraphEditor(graph);

    const before = irConstant(-1);
    const after = irConstant(1);
    editor.insertBefore(anchor, before);
    editor.insertAfter(anchor, after);

    expect(block.nodes).toEqual([before, anchor, after]);
    expect(before.block).toBe(block);
    expect(after.block).toBe(block);
  });

  it("removes an unused node that no frame state names", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const value = irConstant(1);
    block.addNode(value);

    expect(new GraphEditor(graph).removeIfDead(value)).toBe(true);
    expect(block.nodes).not.toContain(value);
  });

  it("keeps an unused node a frame state still names", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const value = irConstant(1);
    const ret = new CFGInstruction("Return");
    ret.addInput(irConstant(0));
    ret.frameState = frameStateNaming(value);
    block.addNode(value);
    block.addNode(ret);

    expect(new GraphEditor(graph).removeIfDead(value)).toBe(false);
    expect(block.nodes).toContain(value);
    expect(value.block).toBe(block);
  });

  it("removes a chain of inputs stranded by the root", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const one = irConstant(1);
    const two = irConstant(2);
    const inner = irInt32Add(one, two);
    const outer = irInt32Add(inner, inner);
    for (const node of [one, two, inner, outer]) block.addNode(node);

    expect(new GraphEditor(graph).removeDeadChain(outer)).toBe(4);
    expect(block.nodes).toEqual([]);
  });

  it("stops the chain at an input another node still uses", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const one = irConstant(1);
    const two = irConstant(2);
    const inner = irInt32Add(one, two);
    const kept = irInt32Add(two, two);
    for (const node of [one, two, inner, kept]) block.addNode(node);

    expect(new GraphEditor(graph).removeDeadChain(inner)).toBe(2);
    expect(block.nodes).toEqual([two, kept]);
  });

  it("stops the chain at a node a live frame state names", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const one = irConstant(1);
    const inner = irInt32Add(one, one);
    const outer = irInt32Add(inner, inner);
    const ret = new CFGInstruction("Return");
    ret.addInput(irConstant(0));
    ret.frameState = frameStateNaming(inner);
    for (const node of [one, inner, outer, ret]) block.addNode(node);

    expect(new GraphEditor(graph).removeDeadChain(outer)).toBe(1);
    expect(block.nodes).toEqual([one, inner, ret]);
  });

  it("frees inputs named only by a frame state the chain itself removed", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const spare = irConstant(9);
    const one = irConstant(1);
    const root = irInt32Add(one, one);
    root.frameState = frameStateNaming(one);
    for (const node of [spare, one, root]) block.addNode(node);
    const editor = new GraphEditor(graph);

    expect(editor.removeIfDead(spare)).toBe(true);
    expect(editor.removeDeadChain(root)).toBe(2);
    expect(block.nodes).toEqual([]);
  });

  it("leaves unhomed inputs such as parameters in place", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const parameter = graph.addParameter(0);
    const add = irInt32Add(parameter, parameter);
    block.addNode(add);

    expect(new GraphEditor(graph).removeDeadChain(add)).toBe(1);
    expect(graph.parameters).toEqual([parameter]);
    expect(parameter.block).toBeNull();
  });

  it("replaces a single input via setInput and maintains use-lists", () => {
    const graph = new CFGFunction("t");
    const block = graph.addBlock();
    const one = irConstant(1);
    const three = irConstant(3);
    const two = irConstant(2);
    const add = irInt32Add(one, three);
    block.addNode(one);
    block.addNode(three);
    block.addNode(two);
    block.addNode(add);

    new GraphEditor(graph).setInput(add, 1, two);

    expect(add.inputs).toEqual([one, two]);
    expect(one.uses).toEqual([add]);
    expect(two.uses).toEqual([add]);
    expect(three.uses).toEqual([]);
  });
});
