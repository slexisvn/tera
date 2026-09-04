import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallBuiltin,
  irConstant,
  irReturn,
  resetIRNodeIds,
  IR_BRANCH,
  IR_CALL_BUILTIN,
  IR_CONSTANT,
  IR_GENERIC_COMPARE,
  IR_LOAD_ELEMENT,
  IR_LOAD_FIELD,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import {
  AGGREGATE_CLOSE_TEXT,
  AGGREGATE_OPEN_TEXT,
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  OBJECT_CLOSE_TEXT,
  OBJECT_OPEN_TEXT,
  PRINT_BUILTIN,
  PRINT_TERMINATOR_PROP,
} from "../../../src/optimizing/metadata/builtin-methods.js";
import {
  ABSENCE_COMPARISON,
  NULL_TEXT,
  UNDEFINED_TEXT,
} from "../../../src/optimizing/metadata/printed-values.js";
import { expandAggregatePrints } from "../../../src/optimizing/passes/print-expansion.js";

beforeEach(() => resetIRNodeIds());

const HOLDER = "Held";
const FIELD = "v";

const holderTable = () =>
  buildClassTable([
    {
      name: HOLDER,
      parent: null,
      abstract: false,
      members: [
        {
          name: FIELD,
          declaredType: "int",
          member: "field",
          owner: HOLDER,
          abstract: false,
          visibility: "public",
          static: false,
        },
      ],
      constructorParams: [],
      constructorParamNames: [],
    },
  ]);

function printCall(value: CFGInstruction): CFGInstruction {
  const intrinsic = builtinGlobalIntrinsicByName(PRINT_BUILTIN)!;
  return irCallBuiltin(PRINT_BUILTIN, [value], builtinMethodCallMetadata(intrinsic));
}

function printsParameter(declared: string): CFGFunction {
  const graph = new CFGFunction("shows");
  graph.classes = holderTable();
  graph.declaredSignature = { params: [declared], returns: null };
  const value = graph.addParameter(0);
  const block = graph.addBlock();
  block.addNode(printCall(value));
  block.addNode(irReturn(block.addNode(irConstant(0))));
  return graph;
}

function printsConstant(held: unknown): CFGFunction {
  const graph = new CFGFunction("shows");
  graph.classes = holderTable();
  const block = graph.addBlock();
  block.addNode(printCall(block.addNode(irConstant(held))));
  block.addNode(irReturn(block.addNode(irConstant(0))));
  return graph;
}

function expand(graph: CFGFunction): number {
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return expandAggregatePrints(graph, analyses.get(typeInferenceAnalysisId));
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const ofType = (graph: CFGFunction, type: string): CFGInstruction[] =>
  nodesOf(graph).filter((node) => node.type === type);

const printsOf = (graph: CFGFunction): CFGInstruction[] =>
  ofType(graph, IR_CALL_BUILTIN).filter((node) => String(node.props.name) === PRINT_BUILTIN);

const printedConstants = (graph: CFGFunction): string[] =>
  printsOf(graph)
    .map((node) => node.inputs[0]!)
    .filter((input) => input.type === IR_CONSTANT && typeof input.props.value === "string")
    .map((input) => String(input.props.value));

const absenceTests = (graph: CFGFunction): CFGInstruction[] =>
  ofType(graph, IR_GENERIC_COMPARE).filter((node) => node.props.op === ABSENCE_COMPARISON);

const presentArm = (graph: CFGFunction): number | null => {
  const [tested] = absenceTests(graph);
  const branch = ofType(graph, IR_BRANCH).find((node) => node.inputs[0] === tested);
  return branch === undefined ? null : Number(branch.props.falseBlock);
};

const unexpandedPrints = (graph: CFGFunction): CFGInstruction[] =>
  printsOf(graph).filter((node) => node.props[PRINT_TERMINATOR_PROP] === undefined);

describe("printing a constant the program has no value for", () => {
  it("spells a printed null out as text rather than leaving it to the runtime", () => {
    const graph = printsConstant(null);

    expect(expand(graph)).toBe(1);

    expect(printedConstants(graph)).toEqual([NULL_TEXT]);
    expect(unexpandedPrints(graph)).toHaveLength(0);
  });

  it("spells a printed undefined out as its own word, not as null", () => {
    const graph = printsConstant(undefined);

    expect(expand(graph)).toBe(1);

    expect(printedConstants(graph)).toEqual([UNDEFINED_TEXT]);
  });

  it("leaves a printed number for the runtime to render", () => {
    const graph = printsConstant(7);

    expect(expand(graph)).toBe(0);

    expect(unexpandedPrints(graph)).toHaveLength(1);
  });
});

describe("printing an object the declared type says always holds one", () => {
  it("walks the fields with no test in front of them", () => {
    const graph = printsParameter(HOLDER);

    expect(expand(graph)).toBe(1);

    expect(printedConstants(graph)).toEqual([
      OBJECT_OPEN_TEXT,
      expect.stringContaining(FIELD),
      OBJECT_CLOSE_TEXT,
    ]);
    expect(absenceTests(graph)).toHaveLength(0);
    expect(ofType(graph, IR_LOAD_FIELD)).toHaveLength(1);
  });
});

describe("printing an object the declared type says a reference may not hold", () => {
  it("tests the reference before reading any field off it", () => {
    const graph = printsParameter(`${HOLDER} | null`);

    expect(expand(graph)).toBe(1);

    expect(absenceTests(graph)).toHaveLength(1);
    expect(printedConstants(graph)).toContain(NULL_TEXT);
  });

  it("still walks the fields on the arm where the reference does hold one", () => {
    const graph = printsParameter(`${HOLDER} | null`);
    expand(graph);

    const loads = ofType(graph, IR_LOAD_FIELD);
    expect(loads).toHaveLength(1);
    expect(loads[0]!.block!.id).toBe(presentArm(graph));
    expect(printedConstants(graph)).toEqual(
      expect.arrayContaining([OBJECT_OPEN_TEXT, OBJECT_CLOSE_TEXT]),
    );
  });

  it("spells the flavour of absence the declared type names", () => {
    const graph = printsParameter(`${HOLDER} | undefined`);
    expand(graph);

    expect(printedConstants(graph)).toContain(UNDEFINED_TEXT);
    expect(printedConstants(graph)).not.toContain(NULL_TEXT);
  });
});

describe("printing an array named only by a declared type", () => {
  it("models the array from the declared type with the absence stripped off it", () => {
    const graph = printsParameter("int[] | null");

    expect(expand(graph)).toBe(1);

    expect(ofType(graph, IR_LOAD_ELEMENT)).toHaveLength(1);
    expect(printedConstants(graph)).toEqual(
      expect.arrayContaining([AGGREGATE_OPEN_TEXT, AGGREGATE_CLOSE_TEXT]),
    );
  });

  it("prints the absence word instead of walking the elements when it holds none", () => {
    const graph = printsParameter("int[] | null");
    expand(graph);

    expect(absenceTests(graph)).toHaveLength(1);
    expect(printedConstants(graph)).toContain(NULL_TEXT);
  });

  it("leaves a value whose declared type names no aggregate alone", () => {
    const graph = printsParameter("int | null");

    expect(expand(graph)).toBe(0);

    expect(ofType(graph, IR_LOAD_ELEMENT)).toHaveLength(0);
    expect(unexpandedPrints(graph)).toHaveLength(1);
  });
});
