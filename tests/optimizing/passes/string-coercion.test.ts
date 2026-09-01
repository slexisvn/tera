import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irReturn,
  resetIRNodeIds,
  IR_GENERIC_ADD,
  IR_GENERIC_CALL,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { joinTextConcatenations } from "../../../src/optimizing/passes/string-coercion.js";

beforeEach(() => resetIRNodeIds());

function joining(pieces: readonly string[], receiver: string | number): CFGFunction {
  const graph = new CFGFunction("join");
  const block = graph.addBlock();
  const held = block.addNode(irConstant(receiver));
  const callee = block.addNode(irGenericGetProp(held, "concat"));
  const call = block.addNode(
    irGenericCall(callee, [held, ...pieces.map((piece) => block.addNode(irConstant(piece)))]),
  );
  call.props.isMethod = true;
  block.addNode(irReturn(call));
  graph.rebuildUses();
  return graph;
}

function join(graph: CFGFunction): number {
  return joinTextConcatenations(
    graph,
    new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
  );
}

const nodesOf = (graph: CFGFunction, type: string) =>
  graph.blocks.flatMap((block) => block.nodes).filter((node) => node.type === type);

describe("joinTextConcatenations", () => {
  it("turns a concat of one piece into a single addition", () => {
    const graph = joining(["cd"], "ab");
    join(graph);

    expect(nodesOf(graph, IR_GENERIC_ADD)).toHaveLength(1);
  });

  it("chains one addition per piece a concat was handed", () => {
    const graph = joining(["b", "c", "d"], "a");
    join(graph);

    expect(nodesOf(graph, IR_GENERIC_ADD)).toHaveLength(3);
  });

  it("leaves no call behind once the pieces are joined", () => {
    const graph = joining(["cd"], "ab");
    join(graph);

    expect(nodesOf(graph, IR_GENERIC_CALL)).toEqual([]);
  });

  it("returns what the last addition produced", () => {
    const graph = joining(["b", "c"], "a");
    join(graph);

    const returned = nodesOf(graph, "Return")[0]?.inputs[0];
    expect(returned?.type).toBe(IR_GENERIC_ADD);
  });

  it("leaves a concat alone when the receiver is not text", () => {
    const graph = joining(["b"], 1);

    expect(join(graph)).toBe(0);
  });
});
