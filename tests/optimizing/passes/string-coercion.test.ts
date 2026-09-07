import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irGenericAdd,
  irGenericCall,
  irGenericGetProp,
  irJump,
  irReturn,
  resetIRNodeIds,
  IR_CALL_BUILTIN,
  IR_GENERIC_ADD,
  IR_GENERIC_CALL,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, link } from "../../../src/optimizing/ir/cfg-edit.js";
import {
  AOT_FLOAT_TO_STRING,
  AOT_INT_TO_STRING,
} from "../../../src/optimizing/analyses/aot-legality.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  coerceStringOperands,
  joinTextConcatenations,
} from "../../../src/optimizing/passes/string-coercion.js";

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

function rendering(present: number | string): CFGFunction {
  const graph = new CFGFunction("render");
  const entry = graph.addBlock();
  const found = graph.addBlock();
  const missing = graph.addBlock();
  const join = graph.addBlock();

  const flag = entry.addNode(irConstant(true));
  entry.addNode(irBranch(flag, found, missing));
  link(entry, found);
  link(entry, missing);

  const value = found.addNode(irConstant(present));
  found.addNode(irJump(join));
  const absent = missing.addNode(irConstant(undefined));
  missing.addNode(irJump(join));
  link(found, join);
  link(missing, join);

  const held = addPhi(join, [value, absent]);
  const open = join.addNode(irConstant("["));
  join.addNode(irReturn(join.addNode(irGenericAdd(open, held))));
  graph.rebuildUses();
  return graph;
}

function coerce(graph: CFGFunction): number {
  return coerceStringOperands(
    graph,
    new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
  );
}

const builtinNames = (graph: CFGFunction) =>
  nodesOf(graph, IR_CALL_BUILTIN).map((node) => String(node.props.name));

describe("coerceStringOperands", () => {
  it("renders a possibly absent integer through the float that holds it", () => {
    const graph = rendering(1);
    coerce(graph);

    expect(builtinNames(graph)).toEqual([AOT_FLOAT_TO_STRING]);
  });

  it("renders an integer that is always present through the integer itself", () => {
    const graph = new CFGFunction("render");
    const block = graph.addBlock();
    const open = block.addNode(irConstant("["));
    const value = block.addNode(irConstant(1));
    block.addNode(irReturn(block.addNode(irGenericAdd(open, value))));
    graph.rebuildUses();
    coerce(graph);

    expect(builtinNames(graph)).toEqual([AOT_INT_TO_STRING]);
  });

  it("leaves a possibly absent string uncoerced", () => {
    const graph = rendering("x");

    expect(coerce(graph)).toBe(0);
  });
});
