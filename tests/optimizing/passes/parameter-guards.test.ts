import { beforeEach, describe, expect, it } from "vitest";
import { insertDeclaredParameterGuards } from "../../../src/optimizing/passes/parameter-guards.js";
import {
  CFGFunction,
  type CFGInstruction,
  irCheckPrimitive,
  irCheckSmi,
  irConstant,
  irGenericAdd,
  irReturn,
  IR_CHECK_NUMBER,
  IR_CHECK_PRIMITIVE,
  IR_CHECK_SMI,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import type { FrameState } from "../../../src/deopt/frame-state.js";

beforeEach(() => resetIRNodeIds());

const FRAME_STATE = { id: 1, bytecodeOffset: 0 } as unknown as FrameState;

function graphWith(params: string[]): CFGFunction {
  const graph = new CFGFunction("test");
  graph.declaredSignature = { params, returns: "int" };
  for (let index = 0; index < params.length; index++) graph.addParameter(index);
  graph.addBlock();
  return graph;
}

function consume(graph: CFGFunction, value: CFGInstruction): CFGInstruction {
  const block = graph.blocks[0]!;
  const other = irConstant(1);
  block.addNode(other);
  const use = irGenericAdd(value, other);
  use.frameState = FRAME_STATE;
  block.addNode(use);
  block.addNode(irReturn(use));
  graph.rebuildUses();
  return use;
}

function opcodesOf(graph: CFGFunction): string[] {
  return graph.blocks.flatMap((block) => block.nodes.map((node) => node.type));
}

describe("insertDeclaredParameterGuards", () => {
  it("guards a declared int parameter with a smi check", () => {
    const graph = graphWith(["int"]);
    consume(graph, graph.parameters[0]!);

    expect(insertDeclaredParameterGuards(graph)).toBe(1);
    expect(opcodesOf(graph)).toContain(IR_CHECK_SMI);
  });

  it("guards a declared float parameter with a number check", () => {
    const graph = graphWith(["float"]);
    consume(graph, graph.parameters[0]!);

    expect(insertDeclaredParameterGuards(graph)).toBe(1);
    expect(opcodesOf(graph)).toContain(IR_CHECK_NUMBER);
  });

  it("guards a declared string parameter with the matching primitive check", () => {
    const graph = graphWith(["string"]);
    consume(graph, graph.parameters[0]!);

    expect(insertDeclaredParameterGuards(graph)).toBe(1);
    const guard = graph.blocks[0]!.nodes.find((node) => node.type === IR_CHECK_PRIMITIVE);
    expect(guard?.props.primitive).toBe("string");
  });

  it("routes every existing use of the parameter through the guard", () => {
    const graph = graphWith(["int"]);
    const use = consume(graph, graph.parameters[0]!);

    insertDeclaredParameterGuards(graph);

    const guard = graph.blocks[0]!.nodes.find((node) => node.type === IR_CHECK_SMI)!;
    expect(use.inputs[0]).toBe(guard);
    expect(guard.inputs[0]).toBe(graph.parameters[0]);
  });

  it("adds nothing for an undeclared parameter", () => {
    const graph = new CFGFunction("test");
    graph.addParameter(0);
    graph.addBlock();
    consume(graph, graph.parameters[0]!);

    expect(insertDeclaredParameterGuards(graph)).toBe(0);
  });

  it("adds nothing when the parameter is already guarded by the same check first", () => {
    const graph = graphWith(["int"]);
    const block = graph.blocks[0]!;
    const existing = irCheckSmi(graph.parameters[0]!);
    existing.frameState = FRAME_STATE;
    block.addNode(existing);
    consume(graph, existing);

    expect(insertDeclaredParameterGuards(graph)).toBe(0);
    expect(opcodesOf(graph).filter((type) => type === IR_CHECK_SMI)).toHaveLength(1);
  });

  it("still guards when the existing check proves a different type", () => {
    const graph = graphWith(["string"]);
    const block = graph.blocks[0]!;
    const existing = irCheckSmi(graph.parameters[0]!);
    existing.frameState = FRAME_STATE;
    block.addNode(existing);
    consume(graph, existing);

    expect(insertDeclaredParameterGuards(graph)).toBe(1);
    expect(opcodesOf(graph)).toContain(IR_CHECK_PRIMITIVE);
  });

  it("still guards when the existing check proves a different primitive", () => {
    const graph = graphWith(["string"]);
    const block = graph.blocks[0]!;
    const existing = irCheckPrimitive(graph.parameters[0]!, "boolean");
    existing.frameState = FRAME_STATE;
    block.addNode(existing);
    consume(graph, existing);

    expect(insertDeclaredParameterGuards(graph)).toBe(1);
    const guards = graph.blocks[0]!.nodes.filter((node) => node.type === IR_CHECK_PRIMITIVE);
    expect(guards.map((node) => node.props.primitive)).toContain("string");
  });

  it("still guards when a matching check does not dominate every use", () => {
    const graph = graphWith(["int"]);
    const block = graph.blocks[0]!;
    const param = graph.parameters[0]!;
    const unguarded = irConstant(2);
    block.addNode(unguarded);
    const early = irGenericAdd(param, unguarded);
    early.frameState = FRAME_STATE;
    block.addNode(early);
    const late = irCheckSmi(param);
    late.frameState = FRAME_STATE;
    block.addNode(late);
    block.addNode(irReturn(late));
    graph.rebuildUses();

    expect(insertDeclaredParameterGuards(graph)).toBe(1);
    expect(early.inputs[0]!.type).toBe(IR_CHECK_SMI);
  });

  it("guards each declared parameter of a multi-parameter signature", () => {
    const graph = graphWith(["int", "string"]);
    const block = graph.blocks[0]!;
    const sum = irGenericAdd(graph.parameters[0]!, graph.parameters[1]!);
    sum.frameState = FRAME_STATE;
    block.addNode(sum);
    block.addNode(irReturn(sum));
    graph.rebuildUses();

    expect(insertDeclaredParameterGuards(graph)).toBe(2);
    expect(opcodesOf(graph)).toContain(IR_CHECK_SMI);
    expect(opcodesOf(graph)).toContain(IR_CHECK_PRIMITIVE);
  });

  it("adds nothing when the entry block offers no deopt target", () => {
    const graph = graphWith(["int"]);
    const block = graph.blocks[0]!;
    const other = irConstant(1);
    block.addNode(other);
    const use = irGenericAdd(graph.parameters[0]!, other);
    block.addNode(use);
    block.addNode(irReturn(use));
    graph.rebuildUses();

    expect(insertDeclaredParameterGuards(graph)).toBe(0);
  });
});
