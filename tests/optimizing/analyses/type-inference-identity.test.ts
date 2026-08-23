import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irInt32Add,
  irNewArray,
  irReturn,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry } from "../../../src/optimizing/analyses/index.js";
import { typeInferenceAnalysisId } from "../../../src/optimizing/analyses/type-inference.js";
import { TypeKind } from "../../../src/optimizing/types/lattice.js";

beforeEach(() => resetIRNodeIds());

function typesOf(graph: CFGFunction) {
  graph.rebuildUses();
  return new AnalysisManager<CFGFunction>(graph, createAnalysisRegistry()).get(
    typeInferenceAnalysisId,
  );
}

describe("type inference when two nodes share an id", () => {
  it("types an array whose id a constant already took", () => {
    const graph = new CFGFunction("collides");
    graph.declaredSignature = { params: [], names: [], returns: "int" };
    const block = graph.addBlock();
    const first = block.addNode(irConstant(1));
    const second = block.addNode(irConstant(2));
    const array = block.addNode(irNewArray([first, second]));
    block.addNode(irReturn(array));
    second.id = first.id;
    array.id = first.id;

    expect(typesOf(graph).typeOf(array).kind).toBe(TypeKind.Array);
  });

  it("keeps each colliding node's own type rather than the last one written", () => {
    const graph = new CFGFunction("shared");
    graph.declaredSignature = { params: [], names: [], returns: "int" };
    const block = graph.addBlock();
    const one = block.addNode(irConstant(1));
    const two = block.addNode(irConstant(2));
    const sum: CFGInstruction = block.addNode(irInt32Add(one, two));
    const array = block.addNode(irNewArray([sum]));
    block.addNode(irReturn(array));
    array.id = sum.id;

    const types = typesOf(graph);
    expect(types.typeOf(array).kind).toBe(TypeKind.Array);
    expect(types.typeOf(sum).kind).not.toBe(TypeKind.Array);
  });
});
