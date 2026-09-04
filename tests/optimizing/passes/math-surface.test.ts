import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_GENERIC_COMPARE,
  IR_GENERIC_GET_PROP,
  IR_SELECT,
  type CFGBlock,
  type CFGFunction as Graph,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { lowerMathSurface } from "../../../src/optimizing/passes/math-surface.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

function appended(block: CFGBlock, node: CFGInstruction): CFGInstruction {
  block.addNode(node);
  return node;
}

function namespaceCall(
  block: CFGBlock,
  member: string,
  args: readonly CFGInstruction[],
): CFGInstruction {
  const namespace = appended(block, irLoadGlobal("Math"));
  const name = appended(block, irConstant(member));
  const callee = appended(block, irGenericGetProp(namespace, name));
  callee.props.propName = member;
  const call = appended(block, irGenericCall(callee, [namespace, ...args]));
  call.props.isMethod = true;
  return call;
}

function graphCalling(member: string, argCount: number): Graph {
  const graph = new CFGFunction("signed");
  graph.declaredSignature = {
    params: Array.from({ length: argCount }, () => "float"),
    returns: "float",
  };
  const block = graph.addBlock();
  const args = Array.from({ length: argCount }, (_unused, index) => graph.addParameter(index));
  const call = namespaceCall(block, member, args);
  appended(block, irReturn(call));
  graph.rebuildUses();
  return graph;
}

const nodesOf = (graph: Graph): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const countOf = (graph: Graph, type: string): number =>
  nodesOf(graph).filter((node) => node.type === type).length;

const constantsOf = (graph: Graph): unknown[] =>
  nodesOf(graph)
    .filter((node) => node.type === IR_CONSTANT)
    .map((node) => node.props.value);

describe("Math.sign lowered in the middle end", () => {
  it("leaves no generic Math call for a backend to refuse", () => {
    const graph = graphCalling("sign", 1);

    expect(lowerMathSurface(graph)).toBe(1);

    expect(countOf(graph, IR_GENERIC_CALL)).toBe(0);
    const member = nodesOf(graph).find((node) => node.type === IR_GENERIC_GET_PROP);
    expect(member!.uses).toHaveLength(0);
  });

  it("asks whether the value is above zero and whether it is below", () => {
    const graph = graphCalling("sign", 1);

    lowerMathSurface(graph);

    const compares = nodesOf(graph).filter((node) => node.type === IR_GENERIC_COMPARE);
    expect(compares.map((node) => node.props.op)).toEqual([">", "<"]);
    for (const compare of compares) {
      expect(compare.inputs[0]).toBe(graph.parameters[0]);
      expect(compare.inputs[1]!.props.value).toBe(0);
    }
  });

  it("answers one, minus one, or the value itself so zero and NaN survive", () => {
    const graph = graphCalling("sign", 1);

    lowerMathSurface(graph);

    const selects = nodesOf(graph).filter((node) => node.type === IR_SELECT);
    expect(selects).toHaveLength(2);
    const [below, signed] = selects as [CFGInstruction, CFGInstruction];
    expect(below.inputs[1]!.props.value).toBe(-1);
    expect(below.inputs[2]).toBe(graph.parameters[0]);
    expect(signed.inputs[1]!.props.value).toBe(1);
    expect(signed.inputs[2]).toBe(below);
    expect(constantsOf(graph)).toEqual(expect.arrayContaining([0, 1, -1]));
  });

  it("returns the selection rather than the call it replaced", () => {
    const graph = graphCalling("sign", 1);

    lowerMathSurface(graph);

    const returned = nodesOf(graph).find((node) => node.type === "Return");
    expect(returned!.inputs[0]!.type).toBe(IR_SELECT);
    validateGraphInvariants(graph);
  });

  it("leaves a sign call with the wrong argument count alone", () => {
    const graph = graphCalling("sign", 2);

    expect(lowerMathSurface(graph)).toBe(0);

    expect(countOf(graph, IR_GENERIC_CALL)).toBe(1);
    expect(countOf(graph, IR_SELECT)).toBe(0);
  });
});
