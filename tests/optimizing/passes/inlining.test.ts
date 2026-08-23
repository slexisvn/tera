import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irCallKnownFunction,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irInt32Mul,
  irReturn,
  resetIRNodeIds,
  IR_CALL_KNOWN_FUNCTION,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import { ModuleFunctions } from "../../../src/optimizing/metadata/module-functions.js";
import { NAMED_ARGUMENTS_PROP } from "../../../src/optimizing/metadata/call-signatures.js";
import { inlineKnownCalls } from "../../../src/optimizing/passes/inlining.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

function doubles(name: string, returns = "int"): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["int"], names: ["n"], returns };
  const n = graph.addParameter(0);
  const block = graph.addBlock();
  const two = block.addNode(irConstant(2));
  const scaled = block.addNode(irInt32Mul(n, two));
  block.addNode(irReturn(scaled));
  graph.rebuildUses();
  return graph;
}

function branching(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["int"], names: ["n"], returns: "int" };
  const n = graph.addParameter(0);
  const entry = graph.addBlock();
  const zero = entry.addNode(irConstant(0));
  const negative = entry.addNode(irInt32Compare("<", n, zero));
  const low = graph.addBlock();
  const high = graph.addBlock();
  entry.addNode(irBranch(negative, low, high));
  link(entry, low);
  link(entry, high);
  low.addNode(irReturn(zero));
  high.addNode(irReturn(n));
  graph.rebuildUses();
  return graph;
}

function callerOf(callee: string, args = 1): { graph: CFGFunction; call: CFGInstruction } {
  const graph = new CFGFunction("caller");
  graph.declaredSignature = { params: ["int"], names: ["n"], returns: "int" };
  const n = graph.addParameter(0);
  const block = graph.addBlock();
  const passed = args === 1 ? [n] : [n, block.addNode(irConstant(1))];
  const call = block.addNode(irCallKnownFunction({ name: callee } as never, passed));
  const one = block.addNode(irConstant(1));
  block.addNode(irReturn(block.addNode(irInt32Add(call, one))));
  graph.rebuildUses();
  return { graph, call };
}

function inline(caller: CFGFunction, callee: CFGFunction): number {
  const functions = new ModuleFunctions(moduleFromGraphs([caller, callee]));
  return inlineKnownCalls(caller, functions, compilerOptions("speed"));
}

const callsIn = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes).filter((node) => node.type === IR_CALL_KNOWN_FUNCTION);

describe("inlineKnownCalls", () => {
  it("splices a straight-line callee into its caller", () => {
    const { graph } = callerOf("doubles");

    expect(inline(graph, doubles("doubles"))).toBe(1);
    expect(callsIn(graph)).toEqual([]);
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("keeps the caller answering the value the callee returned", () => {
    const { graph } = callerOf("doubles");
    inline(graph, doubles("doubles"));

    const returned = graph.blocks[0]!.getTerminator()!;
    const sum = returned.inputs[0]!;
    expect(sum.inputs[0]!.type).toBe("Int32Mul");
  });

  it("splices a callee that branches, and merges its answers into one phi", () => {
    const { graph } = callerOf("branching");

    expect(inline(graph, branching("branching"))).toBe(1);
    expect(callsIn(graph)).toEqual([]);
    const merged = graph.blocks.flatMap((block) => block.phis);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.inputs).toHaveLength(2);
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("leaves the caller reading the phi wherever it read the call", () => {
    const { graph } = callerOf("branching");
    inline(graph, branching("branching"));

    const answered = graph.blocks.flatMap((block) => block.phis)[0]!;
    const sum = answered.uses.find((use) => use.type === "Int32Add")!;
    expect(sum.inputs[0]).toBe(answered);
  });

  it("keeps the code that followed the call after the spliced body", () => {
    const { graph } = callerOf("branching");
    inline(graph, branching("branching"));

    const returned = graph.blocks.find(
      (block) => block.getTerminator()?.type === "Return",
    )!;
    expect(returned.predecessors).toHaveLength(2);
    expect(returned.nodes.some((node) => node.type === "Int32Add")).toBe(true);
  });

  it("refuses a callee whose entry a back edge re-enters", () => {
    const callee = branching("branching");
    const entry = callee.blocks[0]!;
    const low = callee.blocks[1]!;
    link(low, entry);
    callee.rebuildUses();
    const { graph } = callerOf("branching");

    expect(inline(graph, callee)).toBe(0);
  });

  it("leaves a call that passes the wrong number of arguments alone", () => {
    const { graph } = callerOf("doubles", 2);

    expect(inline(graph, doubles("doubles"))).toBe(0);
    expect(callsIn(graph)).toHaveLength(1);
  });

  it("leaves a call whose arguments are named alone", () => {
    const { graph, call } = callerOf("doubles");
    call.props[NAMED_ARGUMENTS_PROP] = ["n"];

    expect(inline(graph, doubles("doubles"))).toBe(0);
    expect(callsIn(graph)).toHaveLength(1);
  });

  it("leaves a callee that answers a string alone", () => {
    const { graph } = callerOf("doubles");

    expect(inline(graph, doubles("doubles", "string"))).toBe(0);
    expect(callsIn(graph)).toHaveLength(1);
  });

  it("leaves a callee that calls itself alone", () => {
    const graph = doubles("doubles");
    const block = graph.blocks[0]!;
    const call = irCallKnownFunction({ name: "doubles" } as never, [graph.parameters[0]!]);
    block.nodes.splice(block.nodes.length - 1, 0, call);
    call.block = block;
    graph.rebuildUses();

    expect(inline(graph, graph)).toBe(0);
  });
});
