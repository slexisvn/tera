import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irInt32Add,
  irInt32Mul,
  irReturn,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { sparseConditionalConstantPropagation } from "../../../src/optimizing/passes/sccp.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

function folding(): CFGFunction {
  const graph = new CFGFunction("folds");
  graph.declaredSignature = { params: [], names: [], returns: "int" };
  const block = graph.addBlock();
  const two = block.addNode(irConstant(2));
  const three = block.addNode(irConstant(3));
  const product = block.addNode(irInt32Mul(two, three));
  const five = block.addNode(irConstant(5));
  block.addNode(irReturn(block.addNode(irInt32Add(product, five))));
  graph.rebuildUses();
  return graph;
}

const idsIn = (graph: CFGFunction): number[] =>
  graph.blocks.flatMap((block) => block.nodes.map((node) => node.id));

describe("sccp keeps node identity", () => {
  it("gives every constant it folds an id no other node holds", () => {
    const graph = folding();
    resetIRNodeIds();

    expect(sparseConditionalConstantPropagation(graph)).toBeGreaterThan(0);
    const ids = idsIn(graph);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("leaves a graph the verifier still accepts", () => {
    const graph = folding();
    resetIRNodeIds();
    sparseConditionalConstantPropagation(graph);
    graph.rebuildUses();

    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("answers the value the arithmetic folds to", () => {
    const graph = folding();
    sparseConditionalConstantPropagation(graph);

    const returned = graph.blocks[0]!.getTerminator()!.inputs[0]!;
    expect(returned.props.value).toBe(11);
  });
});
