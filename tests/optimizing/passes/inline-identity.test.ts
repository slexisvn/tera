import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallKnownFunction,
  irConstant,
  irInt32Add,
  irReturn,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import { ModuleFunctions } from "../../../src/optimizing/metadata/module-functions.js";
import { inlineKnownCalls } from "../../../src/optimizing/passes/inlining.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

function answering(name: string, held: "parameter" | "sum"): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["int"], names: ["n"], returns: "int" };
  const n = graph.addParameter(0);
  const block = graph.addBlock();
  if (held === "parameter") block.addNode(irReturn(n));
  else block.addNode(irReturn(block.addNode(irInt32Add(n, block.addNode(irConstant(2))))));
  graph.rebuildUses();
  return graph;
}

function caller(callee: string): { graph: CFGFunction; call: CFGInstruction } {
  const graph = new CFGFunction("caller");
  graph.declaredSignature = { params: ["int"], names: ["v"], returns: "int" };
  const v = graph.addParameter(0);
  const block = graph.addBlock();
  const call = block.addNode(irCallKnownFunction({ name: callee } as never, [v]));
  const one = block.addNode(irConstant(1));
  block.addNode(irReturn(block.addNode(irInt32Add(call, one))));
  graph.rebuildUses();
  return { graph, call };
}

function inline(graph: CFGFunction, callee: CFGFunction): number {
  const functions = new ModuleFunctions(moduleFromGraphs([graph, callee]));
  return inlineKnownCalls(graph, functions, compilerOptions("speed"));
}

const definedIn = (graph: CFGFunction): Set<CFGInstruction> =>
  new Set([...graph.parameters, ...graph.blocks.flatMap((block) => block.nodes)]);

describe("inlining a callee that answers one of its parameters", () => {
  it("hands the caller the argument it passed, not the callee's parameter", () => {
    const { graph } = caller("same");

    expect(inline(graph, answering("same", "parameter"))).toBe(1);
    const sum = graph.blocks[0]!.getTerminator()!.inputs[0]!;
    expect(sum.inputs[0]).toBe(graph.parameters[0]);
  });

  it("leaves every value it reads defined inside the caller", () => {
    const { graph } = caller("same");
    inline(graph, answering("same", "parameter"));

    const defined = definedIn(graph);
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        for (const input of node.inputs) expect(defined.has(input)).toBe(true);
      }
    }
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("still splices a callee that answers a value it computed", () => {
    const { graph } = caller("plus");

    expect(inline(graph, answering("plus", "sum"))).toBe(1);
    const sum = graph.blocks[0]!.getTerminator()!.inputs[0]!;
    expect(sum.inputs[0]!.type).toBe("Int32Add");
  });
});
