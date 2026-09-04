import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallBuiltin,
  irConstant,
  irGenericAdd,
  irGenericCall,
  irGenericGetProp,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_GENERIC_COMPARE,
  IR_PHI,
  IR_RETURN,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  PRINT_BUILTIN,
  STRING_BUILTIN,
  TO_STRING_MEMBER,
} from "../../../src/optimizing/metadata/builtin-methods.js";
import {
  ABSENCE_COMPARISON,
  BOOLEAN_TEXT,
  NULL_TEXT,
  UNDEFINED_TEXT,
} from "../../../src/optimizing/metadata/printed-values.js";
import { lowerPrintedText } from "../../../src/optimizing/passes/printed-text.js";

beforeEach(() => resetIRNodeIds());

const JOINED_TEXT = "v=";

interface Fixture {
  readonly graph: CFGFunction;
  readonly value: CFGInstruction;
  readonly reader: CFGInstruction;
}

function taking(declared: string) {
  const graph = new CFGFunction("shows");
  graph.classes = buildClassTable([]);
  graph.declaredSignature = { params: [declared], returns: null };
  const value = graph.addParameter(0);
  return { graph, value, block: graph.addBlock() };
}

function renderedByGlobal(declared: string): Fixture {
  const { graph, value, block } = taking(declared);
  const callee = block.addNode(irLoadGlobal(STRING_BUILTIN));
  const reader = block.addNode(irGenericCall(callee, [value]));
  block.addNode(irReturn(reader));
  return { graph, value, reader };
}

function renderedByMethod(declared: string): Fixture {
  const { graph, value, block } = taking(declared);
  const callee = block.addNode(irGenericGetProp(value, TO_STRING_MEMBER));
  const reader = block.addNode(irGenericCall(callee, [value]));
  reader.props.isMethod = true;
  block.addNode(irReturn(reader));
  return { graph, value, reader };
}

function printed(declared: string): Fixture {
  const { graph, value, block } = taking(declared);
  const intrinsic = builtinGlobalIntrinsicByName(PRINT_BUILTIN)!;
  const reader = block.addNode(
    irCallBuiltin(PRINT_BUILTIN, [value], builtinMethodCallMetadata(intrinsic)),
  );
  block.addNode(irReturn(block.addNode(irConstant(0))));
  return { graph, value, reader };
}

function joined(declared: string): Fixture {
  const { graph, value, block } = taking(declared);
  const reader = block.addNode(irGenericAdd(block.addNode(irConstant(JOINED_TEXT)), value));
  block.addNode(irReturn(reader));
  return { graph, value, reader };
}

function lower(graph: CFGFunction): number {
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return lowerPrintedText(graph, analyses.get(typeInferenceAnalysisId));
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const ofType = (graph: CFGFunction, type: string): CFGInstruction[] =>
  nodesOf(graph).filter((node) => node.type === type);

const spelledWords = (graph: CFGFunction): unknown[] =>
  ofType(graph, IR_CONSTANT)
    .map((node) => node.props.value)
    .filter((held) => typeof held === "string");

const absenceTests = (graph: CFGFunction): CFGInstruction[] =>
  ofType(graph, IR_GENERIC_COMPARE).filter((node) => node.props.op === ABSENCE_COMPARISON);

describe("a boolean asked for its own spelling", () => {
  it("answers a merge of the two words rather than a call the backend cannot emit", () => {
    const { graph, reader } = renderedByGlobal("bool");

    expect(lower(graph)).toBe(1);

    expect(ofType(graph, IR_GENERIC_CALL)).toHaveLength(0);
    expect(spelledWords(graph)).toEqual([...BOOLEAN_TEXT]);
    expect(reader.uses).toHaveLength(0);
  });

  it("returns that merge in place of the call it replaced", () => {
    const { graph } = renderedByGlobal("bool");
    lower(graph);

    const returned = ofType(graph, IR_RETURN)[0]!;
    expect(returned.inputs[0]!.type).toBe(IR_PHI);
  });

  it("reads the same request written as a member of the value", () => {
    const { graph } = renderedByMethod("bool");

    expect(lower(graph)).toBe(1);

    expect(ofType(graph, IR_GENERIC_CALL)).toHaveLength(0);
    expect(spelledWords(graph)).toEqual([...BOOLEAN_TEXT]);
  });

  it("leaves the request alone when the value it renders is not a boolean", () => {
    const { graph, reader } = renderedByGlobal("string");

    expect(lower(graph)).toBe(0);

    expect(ofType(graph, IR_GENERIC_CALL)).toEqual([reader]);
  });
});

describe("a boolean handed straight to something that reads text", () => {
  it("hands a print the chosen word instead of the boolean", () => {
    const { graph, reader } = printed("bool");

    expect(lower(graph)).toBe(1);

    expect(reader.inputs[0]!.type).toBe(IR_PHI);
    expect(spelledWords(graph)).toEqual([...BOOLEAN_TEXT]);
  });

  it("hands text it is joined into the chosen word as well", () => {
    const { graph, reader } = joined("bool");

    expect(lower(graph)).toBe(1);

    expect(reader.inputs[1]!.type).toBe(IR_PHI);
  });

  it("leaves a printed number alone", () => {
    const { graph, value, reader } = printed("int");

    expect(lower(graph)).toBe(0);

    expect(reader.inputs[0]).toBe(value);
  });
});

describe("a printed reference the declared type says may be unset", () => {
  it("chooses the word undefined under a test of the reference", () => {
    const { graph, reader } = printed("string | undefined");

    expect(lower(graph)).toBe(1);

    expect(absenceTests(graph)).toHaveLength(1);
    expect(reader.inputs[0]!.type).toBe(IR_PHI);
    expect(spelledWords(graph)).toContain(UNDEFINED_TEXT);
  });

  it("keeps the value itself on the arm where the reference does hold one", () => {
    const { graph, value, reader } = printed("string | undefined");
    lower(graph);

    expect(reader.inputs[0]!.inputs).toContain(value);
  });

  it("spells it for text the reference is joined into as well", () => {
    const { graph, reader } = joined("string | undefined");

    expect(lower(graph)).toBe(1);

    expect(reader.inputs[1]!.type).toBe(IR_PHI);
    expect(spelledWords(graph)).toContain(UNDEFINED_TEXT);
  });

  it("leaves a null-carrying reference to the runtime, which already spells that one", () => {
    const { graph, value, reader } = printed("string | null");

    expect(lower(graph)).toBe(0);

    expect(reader.inputs[0]).toBe(value);
    expect(spelledWords(graph)).not.toContain(NULL_TEXT);
    expect(absenceTests(graph)).toHaveLength(0);
  });

  it("leaves a numeric absence to its own payload rather than branching on it", () => {
    const { graph, value, reader } = printed("int | undefined");

    expect(lower(graph)).toBe(0);

    expect(reader.inputs[0]).toBe(value);
    expect(absenceTests(graph)).toHaveLength(0);
  });

  it("leaves a reference that carries no absence at all alone", () => {
    const { graph, value, reader } = printed("string");

    expect(lower(graph)).toBe(0);

    expect(reader.inputs[0]).toBe(value);
  });
});
