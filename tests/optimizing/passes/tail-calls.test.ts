import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irCallKnownFunction,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irInt32Sub,
  irReturn,
  resetIRNodeIds,
  IR_CALL_KNOWN_FUNCTION,
  IR_PHI,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import { ModuleFunctions } from "../../../src/optimizing/metadata/module-functions.js";
import { NAMED_ARGUMENTS_PROP } from "../../../src/optimizing/metadata/call-signatures.js";
import { rewriteSelfTailCalls } from "../../../src/optimizing/passes/tail-calls.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

interface Recursive {
  readonly graph: CFGFunction;
  readonly call: CFGInstruction;
  readonly returned: CFGInstruction;
}

function summing(name = "sum", callee = name): Recursive {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["int", "int"], names: ["n", "acc"], returns: "int" };
  const n = graph.addParameter(0);
  const acc = graph.addParameter(1);

  const entry = graph.addBlock();
  const done = graph.addBlock();
  const recur = graph.addBlock();
  const zero = entry.addNode(irConstant(0));
  entry.addNode(irBranch(entry.addNode(irInt32Compare("<=", n, zero)), done, recur));
  link(entry, done);
  link(entry, recur);

  done.addNode(irReturn(acc));

  const one = recur.addNode(irConstant(1));
  const next = recur.addNode(irInt32Sub(n, one));
  const total = recur.addNode(irInt32Add(acc, n));
  const call = recur.addNode(irCallKnownFunction({ name: callee } as never, [next, total]));
  const returned = recur.addNode(irReturn(call));
  graph.rebuildUses();
  return { graph, call, returned };
}

const rewrite = (graph: CFGFunction): number =>
  rewriteSelfTailCalls(graph, new ModuleFunctions(moduleFromGraphs([graph])));

const callsIn = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks
    .flatMap((block) => block.nodes)
    .filter((node) => node.type === IR_CALL_KNOWN_FUNCTION);

describe("rewriteSelfTailCalls", () => {
  it("turns a self call in tail position into a back edge", () => {
    const { graph } = summing();

    expect(rewrite(graph)).toBe(1);
    expect(callsIn(graph)).toEqual([]);
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("carries each argument into the parameter it replaces", () => {
    const { graph } = summing();
    const [n, acc] = graph.parameters;
    rewrite(graph);

    const header = graph.entry!.successors[0]!;
    expect(header.isLoopHeader).toBe(true);
    expect(header.phis).toHaveLength(2);
    expect(header.phis.map((phi) => phi.type)).toEqual([IR_PHI, IR_PHI]);
    expect(header.phis[0]!.inputs[0]).toBe(n);
    expect(header.phis[1]!.inputs[0]).toBe(acc);
    expect(header.phis[0]!.inputs[1]!.type).toBe("Int32Sub");
    expect(header.phis[1]!.inputs[1]!.type).toBe("Int32Add");
  });

  it("reads every parameter through the phi that the loop updates", () => {
    const { graph } = summing();
    rewrite(graph);

    for (const parameter of graph.parameters) {
      expect(parameter.uses.every((use) => use.type === IR_PHI)).toBe(true);
    }
  });

  it("leaves the entry as the only block without a predecessor", () => {
    const { graph } = summing();
    rewrite(graph);

    const roots = graph.blocks.filter((block) => block.predecessors.length === 0);
    expect(roots).toEqual([graph.entry]);
    expect(graph.blocks[0]).toBe(graph.entry);
  });

  it("leaves a call whose result the caller still works on alone", () => {
    const { graph, call, returned } = summing();
    const block = call.block!;
    const one = block.addNode(irConstant(1));
    const scaled = block.addNode(irInt32Add(call, one));
    returned.replaceInput(0, scaled);
    block.nodes.splice(block.nodes.indexOf(returned), 1);
    block.nodes.push(returned);
    graph.rebuildUses();

    expect(rewrite(graph)).toBe(0);
    expect(callsIn(graph)).toHaveLength(1);
  });

  it("leaves a call whose arguments are named alone", () => {
    const { graph, call } = summing();
    call.props[NAMED_ARGUMENTS_PROP] = ["n", "acc"];

    expect(rewrite(graph)).toBe(0);
  });

  it("leaves a coroutine alone", () => {
    const { graph } = summing();
    graph.isAsync = true;

    expect(rewrite(graph)).toBe(0);
  });

  it("leaves a function that recovers throws alone", () => {
    const { graph } = summing();
    graph.recoversThrows = true;

    expect(rewrite(graph)).toBe(0);
  });

  it("leaves a tail call to a different function alone", () => {
    const { graph } = summing("ping", "pong");
    const other = summing("pong", "ping").graph;
    const functions = new ModuleFunctions(moduleFromGraphs([graph, other]));

    expect(rewriteSelfTailCalls(graph, functions)).toBe(0);
    expect(callsIn(graph)).toHaveLength(1);
  });
});
