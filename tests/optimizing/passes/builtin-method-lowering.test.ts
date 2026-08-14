import { describe, it, expect, beforeEach } from "vitest";
import { lowerBuiltinMethods } from "../../../src/optimizing/passes/builtin-method-lowering.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  CFGFunction,
  type CFGInstruction,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irReturn,
  IR_CALL_BUILTIN,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_RETURN,
  irRequiresFrameState,
  isReadOnly,
  clobbersAllMemory,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import type { FrameState } from "../../../src/deopt/frame-state.js";

beforeEach(() => resetIRNodeIds());

function lower(graph: CFGFunction): number {
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return lowerBuiltinMethods(graph, analyses.get(typeInferenceAnalysisId));
}

function nodesOf(graph: CFGFunction): CFGInstruction[] {
  return graph.blocks.flatMap((block) => block.nodes);
}

function methodCall(
  graph: CFGFunction,
  receiver: CFGInstruction,
  name: string,
  args: CFGInstruction[],
  terminate = true,
): CFGInstruction {
  const block = graph.blocks[0]!;
  const callee = irGenericGetProp(receiver, name);
  block.addNode(callee);
  const call = irGenericCall(callee, [receiver, ...args]);
  call.props.isMethod = true;
  block.addNode(call);
  if (terminate) block.addNode(irReturn(call));
  return call;
}

function stringReceiverGraph(name: string, args: number[]): CFGFunction {
  const graph = new CFGFunction("test");
  const block = graph.addBlock();
  const receiver = irConstant("hello");
  block.addNode(receiver);
  const argNodes = args.map((value) => {
    const node = irConstant(value);
    block.addNode(node);
    return node;
  });
  methodCall(graph, receiver, name, argNodes);
  return graph;
}

describe("lowerBuiltinMethods", () => {
  it("replaces a declared string method call with a builtin call", () => {
    const graph = stringReceiverGraph("char_code_at", [1]);

    expect(lower(graph)).toBe(1);

    const types = nodesOf(graph).map((node) => node.type);
    expect(types).toContain(IR_CALL_BUILTIN);
    expect(types).not.toContain(IR_GENERIC_CALL);
    expect(types).not.toContain(IR_GENERIC_GET_PROP);
  });

  it("keeps the receiver as the first argument of the builtin call", () => {
    const graph = stringReceiverGraph("char_code_at", [1]);
    lower(graph);

    const call = nodesOf(graph).find((node) => node.type === IR_CALL_BUILTIN)!;
    expect(call.props.name).toBe("string.char_code_at");
    expect(call.props.argCount).toBe(2);
    expect(call.inputs.map((input) => input.props.value)).toEqual(["hello", 1]);
  });

  it("marks the lowered call pure so it does not clobber the heap", () => {
    const graph = stringReceiverGraph("char_code_at", [1]);
    lower(graph);

    const call = nodesOf(graph).find((node) => node.type === IR_CALL_BUILTIN)!;
    expect(isReadOnly(call)).toBe(true);
    expect(clobbersAllMemory(call)).toBe(false);
  });

  it("leaves a method that the registry does not declare alone", () => {
    const graph = stringReceiverGraph("trim", []);

    expect(lower(graph)).toBe(0);
    expect(nodesOf(graph).map((node) => node.type)).toContain(IR_GENERIC_CALL);
  });

  it("leaves a call whose receiver type is unknown alone", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const receiver = graph.addParameter(0);
    const index = irConstant(1);
    block.addNode(index);
    methodCall(graph, receiver, "char_code_at", [index]);

    expect(lower(graph)).toBe(0);
    expect(nodesOf(graph).map((node) => node.type)).toContain(IR_GENERIC_CALL);
  });

  it("leaves a call whose argument count does not match the declaration alone", () => {
    const graph = stringReceiverGraph("char_code_at", [1, 2]);

    expect(lower(graph)).toBe(0);
    expect(nodesOf(graph).map((node) => node.type)).toContain(IR_GENERIC_CALL);
  });

  it("leaves a plain call that only looks like a method call alone", () => {
    const graph = stringReceiverGraph("char_code_at", [1]);
    const call = nodesOf(graph).find((node) => node.type === IR_GENERIC_CALL)!;
    call.props.isMethod = false;

    expect(lower(graph)).toBe(0);
    expect(nodesOf(graph).map((node) => node.type)).toContain(IR_GENERIC_CALL);
  });

  it("leaves a call whose receiver is not the object the method was read from", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const owner = irConstant("hello");
    const other = irConstant("world");
    const index = irConstant(1);
    block.addNode(owner);
    block.addNode(other);
    block.addNode(index);
    const callee = irGenericGetProp(owner, "char_code_at");
    block.addNode(callee);
    const call = irGenericCall(callee, [other, index]);
    call.props.isMethod = true;
    block.addNode(call);
    block.addNode(irReturn(call));

    expect(lower(graph)).toBe(0);
    expect(nodesOf(graph).map((node) => node.type)).toContain(IR_GENERIC_CALL);
  });

  it("lowers every matching call in the graph", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const receiver = irConstant("hello");
    const first = irConstant(0);
    const second = irConstant(1);
    block.addNode(receiver);
    block.addNode(first);
    block.addNode(second);
    methodCall(graph, receiver, "char_code_at", [first], false);
    methodCall(graph, receiver, "char_code_at", [second], false);
    const calls = nodesOf(graph).filter((node) => node.type === IR_GENERIC_CALL);
    block.addNode(irReturn(calls[1]!));

    expect(lower(graph)).toBe(2);
    expect(nodesOf(graph).filter((node) => node.type === IR_CALL_BUILTIN)).toHaveLength(2);
  });

  it("keeps the method load when something else still reads it", () => {
    const graph = stringReceiverGraph("char_code_at", [1]);
    const block = graph.blocks[0]!;
    const callee = nodesOf(graph).find((node) => node.type === IR_GENERIC_GET_PROP)!;
    const keeper = irGenericGetProp(callee, "name");
    block.nodes.splice(block.nodes.indexOf(callee) + 1, 0, keeper);
    keeper.block = block;

    expect(lower(graph)).toBe(1);
    expect(nodesOf(graph)).toContain(callee);
  });

  it("hands the result of the lowered call to the original consumers", () => {
    const graph = stringReceiverGraph("char_code_at", [1]);
    lower(graph);

    const call = nodesOf(graph).find((node) => node.type === IR_CALL_BUILTIN)!;
    const ret = nodesOf(graph).find((node) => node.type === IR_RETURN)!;

    expect(ret.inputs[0]).toBe(call);
    expect(call.uses).toContain(ret);
  });

  it("drops the frame state because a pure builtin has no deopt point", () => {
    const graph = stringReceiverGraph("char_code_at", [1]);
    const original = nodesOf(graph).find((node) => node.type === IR_GENERIC_CALL)!;
    original.frameState = { id: 7, bytecodeOffset: 3 } as unknown as FrameState;

    lower(graph);

    const call = nodesOf(graph).find((node) => node.type === IR_CALL_BUILTIN)!;
    expect(call.frameState).toBeNull();
    expect(irRequiresFrameState(call)).toBe(false);
  });

  it("lowers a declared string getter to a builtin call on its receiver", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const receiver = irConstant("hello");
    block.addNode(receiver);
    const load = irGenericGetProp(receiver, "length");
    block.addNode(load);
    block.addNode(irReturn(load));

    expect(lower(graph)).toBe(1);

    const call = nodesOf(graph).find((node) => node.type === IR_CALL_BUILTIN)!;
    expect(call.props.name).toBe("string.length");
    expect(call.props.argCount).toBe(1);
    expect(call.inputs).toEqual([receiver]);
    expect(nodesOf(graph).map((node) => node.type)).not.toContain(IR_GENERIC_GET_PROP);
  });

  it("leaves a getter on an unproven receiver alone", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const receiver = graph.addParameter(0);
    const load = irGenericGetProp(receiver, "length");
    block.addNode(load);
    block.addNode(irReturn(load));

    expect(lower(graph)).toBe(0);
    expect(nodesOf(graph).map((node) => node.type)).toContain(IR_GENERIC_GET_PROP);
  });

  it("does not treat a getter as a callable method", () => {
    const graph = stringReceiverGraph("length", []);

    expect(lower(graph)).toBe(1);

    const calls = nodesOf(graph).filter((node) => node.type === IR_CALL_BUILTIN);
    expect(calls).toHaveLength(1);
    expect(nodesOf(graph).map((node) => node.type)).toContain(IR_GENERIC_CALL);
  });

  it("records the lowered call as a use of its receiver and arguments", () => {
    const graph = stringReceiverGraph("char_code_at", [1]);
    lower(graph);

    const call = nodesOf(graph).find((node) => node.type === IR_CALL_BUILTIN)!;
    for (const input of call.inputs) expect(input.uses).toContain(call);
  });
});
