import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  calleeNameOf,
  irConstant,
  irGenericMod,
  irReturn,
  resetIRNodeIds,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_MOD,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { lowerFloatRemainder } from "../../../src/optimizing/passes/float-mod.js";
import { FLOAT_MOD_FN } from "../../../src/optimizing/prelude/float-mod.js";
import type { DeclaredSignature } from "../../../src/optimizing/types/signature.js";

beforeEach(() => resetIRNodeIds());

const HELPER: DeclaredSignature = { params: ["float", "float"], returns: "float" };

interface Built {
  readonly graph: CFGFunction;
  readonly remainder: CFGInstruction;
}

function remaindering(
  operands: readonly (number | "parameter")[],
  declared: readonly string[],
  helper: DeclaredSignature | null = HELPER,
): Built {
  const graph = new CFGFunction("f");
  graph.declaredSignature = { params: [...declared], returns: "float" };
  const parameters = declared.map((_, index) => graph.addParameter(index));
  const block = graph.addBlock();
  let taken = 0;
  const held = operands.map((operand) =>
    operand === "parameter"
      ? parameters[taken++]!
      : block.addNode(irConstant(operand)),
  );
  const remainder = block.addNode(irGenericMod(held[0]!, held[1]!));
  block.addNode(irReturn(remainder));
  if (helper !== null) graph.calleeSignatures = new Map([[FLOAT_MOD_FN, helper]]);
  graph.rebuildUses();
  return { graph, remainder };
}

function lower(graph: CFGFunction): number {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return lowerFloatRemainder(graph, analyses.get(typeInferenceAnalysisId));
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const opcodesIn = (graph: CFGFunction): string[] => nodesOf(graph).map((node) => node.type);

const calledIn = (graph: CFGFunction): (string | null)[] =>
  nodesOf(graph)
    .filter((node) => node.type === IR_CALL_KNOWN_FUNCTION)
    .map((node) => calleeNameOf(node));

describe("lowering a remainder the target cannot take on whole numbers", () => {
  it("hands a remainder of two fractions to the helper", () => {
    const { graph } = remaindering([7.5, 2.5], []);

    expect(lower(graph)).toBe(1);
    expect(calledIn(graph)).toEqual([FLOAT_MOD_FN]);
    expect(opcodesIn(graph)).not.toContain(IR_GENERIC_MOD);
  });

  it("hands over a remainder where only one side is fractional", () => {
    expect(lower(remaindering([7.5, 2], []).graph)).toBe(1);
    expect(lower(remaindering([7, 2.5], []).graph)).toBe(1);
  });

  it("hands over a remainder of values it cannot read until the program runs", () => {
    const { graph } = remaindering(["parameter", "parameter"], ["float", "float"]);

    expect(lower(graph)).toBe(1);
    expect(calledIn(graph)).toEqual([FLOAT_MOD_FN]);
  });

  it("carries the operands over in the order they were written", () => {
    const { graph } = remaindering([7.5, 2.5], []);
    lower(graph);
    const call = nodesOf(graph).find((node) => node.type === IR_CALL_KNOWN_FUNCTION)!;

    expect(call.inputs.map((input) => input.props.value)).toEqual([7.5, 2.5]);
  });

  it("keeps the frame state the remainder it replaced was answering for", () => {
    const { graph, remainder } = remaindering([7.5, 2.5], []);
    const frameState = { id: 7 } as never;
    remainder.frameState = frameState;
    lower(graph);
    const call = nodesOf(graph).find((node) => node.type === IR_CALL_KNOWN_FUNCTION)!;

    expect(call.frameState).toBe(frameState);
  });
});

describe("the remainders the lowering leaves alone", () => {
  it("leaves a remainder of two whole numbers to the target", () => {
    const { graph } = remaindering([7, 2], []);

    expect(lower(graph)).toBe(0);
    expect(opcodesIn(graph)).toContain(IR_GENERIC_MOD);
  });

  it("leaves a remainder of two whole values only the running program knows", () => {
    const { graph } = remaindering(["parameter", "parameter"], ["int", "int"]);

    expect(lower(graph)).toBe(0);
    expect(opcodesIn(graph)).toContain(IR_GENERIC_MOD);
  });

  it("leaves every remainder alone when no helper was compiled alongside", () => {
    const { graph } = remaindering([7.5, 2.5], [], null);

    expect(lower(graph)).toBe(0);
    expect(opcodesIn(graph)).toContain(IR_GENERIC_MOD);
  });
});
