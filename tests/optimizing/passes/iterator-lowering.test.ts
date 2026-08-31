import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
  irIteratorDone,
  irIteratorInit,
  irIteratorNext,
  irIteratorValue,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  IR_INT32_COMPARE,
  IR_ITERATOR_DONE,
  IR_ITERATOR_INIT,
  IR_ITERATOR_NEXT,
  IR_ITERATOR_VALUE,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import { CALLEE_SYMBOL_PROP } from "../../../src/optimizing/metadata/call-signatures.js";
import { lowerIterators } from "../../../src/optimizing/passes/iterator-lowering.js";

beforeEach(() => resetIRNodeIds());

const RANGE = "range";

function lower(graph: CFGFunction): number {
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return lowerIterators(graph, analyses.get(typeInferenceAnalysisId));
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const typesOf = (graph: CFGFunction): string[] => nodesOf(graph).map((node) => node.type);

const ITERATOR_OPS = [IR_ITERATOR_INIT, IR_ITERATOR_NEXT, IR_ITERATOR_DONE, IR_ITERATOR_VALUE];

const iteratorsIn = (graph: CFGFunction): string[] =>
  typesOf(graph).filter((type) => ITERATOR_OPS.includes(type));

function rangeGraph(stop: (graph: CFGFunction, block: CFGFunction["blocks"][number]) => CFGInstruction, rewritten: boolean) {
  const graph = new CFGFunction("counts");
  graph.declaredSignature = { params: [], returns: "int" };
  const block = graph.addBlock();
  const callee = rewritten
    ? block.addNode(irConstant(0))
    : block.addNode(irLoadGlobal(RANGE));
  const zero = block.addNode(irConstant(0));
  const limit = stop(graph, block);
  const call = block.addNode(irGenericCall(callee, [zero, limit]));
  if (rewritten) call.props[CALLEE_SYMBOL_PROP] = RANGE;
  const cursor = block.addNode(irIteratorInit(call));
  const done = block.addNode(irIteratorDone(cursor));
  const value = block.addNode(irIteratorValue(cursor));
  block.addNode(irIteratorNext(cursor));
  block.addNode(irReturn(value));
  return { graph, done };
}

const constantStop = (_graph: CFGFunction, block: CFGFunction["blocks"][number]) =>
  block.addNode(irConstant(4));

describe("lowerIterators over a range", () => {
  it("lowers a range reached through a load of the builtin", () => {
    const { graph } = rangeGraph(constantStop, false);

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });

  it("lowers a range whose callee another pass already rewrote to a symbol", () => {
    const { graph } = rangeGraph(constantStop, true);

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });

  it("compares the cursor against the bound the range was given", () => {
    const { graph, done } = rangeGraph(constantStop, true);
    lower(graph);

    const compare = nodesOf(graph).find((node) => node.type === IR_INT32_COMPARE)!;
    expect(compare.props.op).toBe(">=");
    expect(compare.inputs[1]!.props.value).toBe(4);
    expect(done.block).toBeNull();
  });
});

describe("lowerIterators over a range counted by a global", () => {
  const globalStop = (declaredType: string) => (graph: CFGFunction, block: CFGFunction["blocks"][number]) => {
    const classes = buildClassTable([]);
    classes.declareGlobal("n", declaredType);
    graph.classes = classes;
    return block.addNode(irLoadGlobal("n"));
  };

  it("lowers a range whose bound is a global declared int", () => {
    const { graph } = rangeGraph(globalStop("int"), true);

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });

  it("leaves a range whose bound is a global declared float alone", () => {
    const { graph } = rangeGraph(globalStop("float"), true);

    expect(lower(graph)).toBe(0);
    expect(iteratorsIn(graph)).toHaveLength(4);
  });

  it("leaves a range whose bound is a global declared string alone", () => {
    const { graph } = rangeGraph(globalStop("string"), true);

    expect(lower(graph)).toBe(0);
    expect(iteratorsIn(graph)).toHaveLength(4);
  });
});
