import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irCallKnownFunction,
  irGenericCall,
  irIteratorDone,
  irIteratorInit,
  irIteratorNext,
  irIteratorValue,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_INT32_COMPARE,
  IR_ITERATOR_DONE,
  IR_ITERATOR_INIT,
  IR_ITERATOR_NEXT,
  IR_ITERATOR_VALUE,
  type CFGInstruction,
  CALLEE_SYMBOL_PROP,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import type { ClassMemberSurface } from "../../../src/frontend/modules/interface.js";

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

type CalleeShape = "global" | "symbol" | "resolved";

function rangeCall(
  block: CFGFunction["blocks"][number],
  shape: CalleeShape,
  args: CFGInstruction[],
): CFGInstruction {
  if (shape === "resolved") return block.addNode(irCallKnownFunction({ name: RANGE }, args));
  const callee = block.addNode(
    shape === "symbol" ? irConstant(0) : irLoadGlobal(RANGE),
  );
  const call = block.addNode(irGenericCall(callee, args));
  if (shape === "symbol") call.props[CALLEE_SYMBOL_PROP] = RANGE;
  return call;
}

function rangeGraph(stop: (graph: CFGFunction, block: CFGFunction["blocks"][number]) => CFGInstruction, shape: CalleeShape) {
  const graph = new CFGFunction("counts");
  graph.declaredSignature = { params: [], returns: "int" };
  const block = graph.addBlock();
  const zero = block.addNode(irConstant(0));
  const limit = stop(graph, block);
  const call = rangeCall(block, shape, [zero, limit]);
  const cursor = block.addNode(irIteratorInit(call));
  const done = block.addNode(irIteratorDone(cursor));
  const value = block.addNode(irIteratorValue(cursor));
  block.addNode(irIteratorNext(cursor));
  block.addNode(irReturn(value));
  return { graph, done, call, operands: [...call.inputs] };
}

const constantStop = (_graph: CFGFunction, block: CFGFunction["blocks"][number]) =>
  block.addNode(irConstant(4));

describe("lowerIterators over a range", () => {
  it("lowers a range reached through a load of the builtin", () => {
    const { graph } = rangeGraph(constantStop, "global");

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });

  it("lowers a range whose callee another pass already rewrote to a symbol", () => {
    const { graph } = rangeGraph(constantStop, "symbol");

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });

  it("lowers a range a later pass already resolved to a direct call", () => {
    const { graph } = rangeGraph(constantStop, "resolved");

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });

  it("counts a resolved range from the bound it carries as its own argument", () => {
    const { graph, done } = rangeGraph(constantStop, "resolved");
    lower(graph);

    const compare = nodesOf(graph).find((node) => node.type === IR_INT32_COMPARE)!;
    expect(compare.inputs[1]!.props.value).toBe(4);
    expect(done.block).toBeNull();
  });

  it("compares the cursor against the bound the range was given", () => {
    const { graph, done } = rangeGraph(constantStop, "symbol");
    lower(graph);

    const compare = nodesOf(graph).find((node) => node.type === IR_INT32_COMPARE)!;
    expect(compare.props.op).toBe(">=");
    expect(compare.inputs[1]!.props.value).toBe(4);
    expect(done.block).toBeNull();
  });

  it("drops every operand of the range call it removed, not only the callee", () => {
    const { graph, operands } = rangeGraph(constantStop, "global");
    const [callee, start] = operands as [CFGInstruction, CFGInstruction];

    lower(graph);

    expect(nodesOf(graph)).not.toContain(callee);
    expect(nodesOf(graph)).not.toContain(start);
    expect(start.block).toBeNull();
  });

  it("keeps an operand the lowered code still reads", () => {
    const { graph, operands } = rangeGraph(constantStop, "global");
    const stop = operands[2]!;

    lower(graph);

    expect(nodesOf(graph)).toContain(stop);
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
    const { graph } = rangeGraph(globalStop("int"), "symbol");

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });

  it("leaves a range whose bound is a global declared float alone", () => {
    const { graph } = rangeGraph(globalStop("float"), "symbol");

    expect(lower(graph)).toBe(0);
    expect(iteratorsIn(graph)).toHaveLength(4);
  });

  it("leaves a range whose bound is a global declared string alone", () => {
    const { graph } = rangeGraph(globalStop("string"), "symbol");

    expect(lower(graph)).toBe(0);
    expect(iteratorsIn(graph)).toHaveLength(4);
  });
});

const STEPPER = "Stepper";

function member(name: string, declaredType: string, kind: "field" | "method"): ClassMemberSurface {
  return {
    name,
    declaredType,
    member: kind,
    owner: STEPPER,
    abstract: false,
    visibility: "public",
    static: false,
  };
}

function stepperTable(members: readonly ClassMemberSurface[]) {
  return buildClassTable([
    {
      name: STEPPER,
      parent: null,
      abstract: false,
      members,
      constructorParams: [],
      constructorParamNames: [],
    },
  ]);
}

const STEPS = [member("@@iterator", STEPPER, "method"), member("next", "any", "method")];

function protocolGraph(members: readonly ClassMemberSurface[] = STEPS) {
  const graph = new CFGFunction("walks");
  graph.classes = stepperTable(members);
  graph.declaredSignature = { params: [STEPPER], returns: "int" };
  const block = graph.addBlock();
  const source = graph.addParameter(0);
  const cursor = block.addNode(irIteratorInit(source));
  const step = block.addNode(irIteratorNext(cursor));
  const done = block.addNode(irIteratorDone(step));
  const value = block.addNode(irIteratorValue(step));
  block.addNode(irReturn(value));
  return { graph, source, cursor, step, done, value };
}

const propsNamed = (graph: CFGFunction): unknown[] =>
  nodesOf(graph)
    .filter((node) => node.type === IR_GENERIC_GET_PROP)
    .map((node) => node.props.propName);

describe("lowerIterators over a value that answers the step protocol", () => {
  it("leaves no iterator op for a backend that has none", () => {
    const { graph } = protocolGraph();

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });

  it("steps the source by calling the member it answers with", () => {
    const { graph, source } = protocolGraph();
    lower(graph);

    const call = nodesOf(graph).find((node) => node.type === IR_GENERIC_CALL)!;
    expect(call.props.isMethod).toBe(true);
    expect(call.inputs[0]!.props.propName).toBe("next");
    expect(call.inputs[0]!.inputs[0]).toBe(source);
    expect(call.inputs[1]).toBe(source);
  });

  it("reads whether it is finished and what it holds off that one step", () => {
    const { graph } = protocolGraph();
    lower(graph);

    const call = nodesOf(graph).find((node) => node.type === IR_GENERIC_CALL)!;
    const reads = nodesOf(graph).filter(
      (node) => node.type === IR_GENERIC_GET_PROP && node.inputs[0] === call,
    );

    expect(reads.map((node) => node.props.propName)).toEqual(["done", "value"]);
  });

  it("carries no cursor of its own, since the source keeps the position", () => {
    const { graph } = protocolGraph();
    lower(graph);

    expect(propsNamed(graph)).toEqual(["next", "done", "value"]);
    expect(nodesOf(graph).some((node) => node.type === IR_CONSTANT)).toBe(true);
  });

  it("leaves a value that answers steps but never hands out an iterator alone", () => {
    const { graph } = protocolGraph([member("next", "any", "method")]);

    expect(lower(graph)).toBe(0);
    expect(iteratorsIn(graph)).toHaveLength(4);
  });

  it("leaves a value that hands out an iterator but never steps alone", () => {
    const { graph } = protocolGraph([member("@@iterator", STEPPER, "method")]);

    expect(lower(graph)).toBe(0);
    expect(iteratorsIn(graph)).toHaveLength(4);
  });

  it("takes the protocol off a field spelling it as well as a method", () => {
    const { graph } = protocolGraph([
      member("@@iterator", STEPPER, "field"),
      member("next", "int", "field"),
    ]);

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });
  it("leaves a value whose hook hands back a stepper of its own alone", () => {
    const { graph } = protocolGraph([
      member("@@iterator", "() -> Walker", "method"),
      member("next", "any", "method"),
    ]);

    expect(lower(graph)).toBe(0);
    expect(iteratorsIn(graph)).toHaveLength(4);
  });

  it("steps a value whose hook says it hands back itself", () => {
    const { graph } = protocolGraph([
      member("@@iterator", `() -> ${STEPPER}`, "method"),
      member("next", "any", "method"),
    ]);

    expect(lower(graph)).toBe(4);
    expect(iteratorsIn(graph)).toEqual([]);
  });
});
