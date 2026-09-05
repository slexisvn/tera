import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallBuiltin,
  irConstant,
  irReturn,
  resetIRNodeIds,
  calleeSymbolName,
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { createModuleIR, createCompilationUnit } from "../../../src/optimizing/compilation-unit.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicByName,
  qualifiedMethodName,
  NUMBER_BUILTIN,
  PARSE_FLOAT_BUILTIN,
  PARSE_INT_BUILTIN,
  STRING_TYPE,
  WHOLE_TEXT_PROP,
} from "../../../src/optimizing/metadata/builtin-methods.js";
import { BYTEWISE_PROP, countsCharacters } from "../../../src/optimizing/analyses/wide-text.js";
import {
  lowerParseNumbers,
  markNumberTextBytewise,
} from "../../../src/optimizing/passes/parse-number-surface.js";
import {
  NUMBER_OF_FUNCTION,
  NUMBER_TEXT_READERS,
  PARSE_FLOAT_FUNCTION,
  PARSE_INT_FUNCTION,
} from "../../../src/optimizing/prelude/parse-number.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

const CHAR_CODE_AT = qualifiedMethodName(STRING_TYPE, "char_code_at");
const LENGTH = qualifiedMethodName(STRING_TYPE, "length");

function readingGraph(name: string, builtin: string, whole = false): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["string"], returns: "float" };
  const block = graph.addBlock();
  const text = graph.addParameter(0);
  block.addNode(text);
  const call = irCallBuiltin(builtin, [text]);
  if (whole) call.props[WHOLE_TEXT_PROP] = true;
  block.addNode(call);
  block.addNode(irReturn(call));
  graph.rebuildUses();
  return graph;
}

function measuringGraph(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["string"], returns: "int" };
  const block = graph.addBlock();
  const text = graph.addParameter(0);
  block.addNode(text);
  const index = irConstant(0);
  block.addNode(index);
  for (const member of [LENGTH, CHAR_CODE_AT]) {
    const intrinsic = builtinMethodIntrinsicByName(member)!;
    const inputs = member === LENGTH ? [text] : [text, index];
    block.addNode(irCallBuiltin(member, inputs, builtinMethodCallMetadata(intrinsic)));
  }
  block.addNode(irReturn(index));
  graph.rebuildUses();
  return graph;
}

function nodesOf(graph: CFGFunction): CFGInstruction[] {
  return graph.blocks.flatMap((block) => [...block.nodes]);
}

describe("lowering the number readers onto the prelude", () => {
  for (const [builtin, reader] of [
    [PARSE_FLOAT_BUILTIN, PARSE_FLOAT_FUNCTION],
    [PARSE_INT_BUILTIN, PARSE_INT_FUNCTION],
  ] as const) {
    it(`calls ${reader} where the program called ${builtin}`, () => {
      const graph = readingGraph("reads", builtin);

      expect(lowerParseNumbers(graph)).toBe(1);

      const nodes = nodesOf(graph);
      expect(nodes.some((node) => node.type === IR_CALL_BUILTIN)).toBe(false);
      const call = nodes.find((node) => node.type === IR_CALL_KNOWN_FUNCTION)!;
      expect(calleeSymbolName(call)).toBe(reader);
      expect(call.inputs.length).toBe(1);
      expect(call.inputs[0]).toBe(graph.parameters[0]);
      validateGraphInvariants(graph);
    });
  }

  it("hands the answer to whoever read the builtin's answer", () => {
    const graph = readingGraph("reads", PARSE_FLOAT_BUILTIN);

    lowerParseNumbers(graph);

    const answered = nodesOf(graph).find((node) => node.type === IR_CALL_KNOWN_FUNCTION)!;
    expect(answered.uses.map((use) => use.type)).toContain("Return");
  });

  it("calls the whole-text reader where the program spelled " + NUMBER_BUILTIN, () => {
    const graph = readingGraph("reads", PARSE_FLOAT_BUILTIN, true);

    expect(lowerParseNumbers(graph)).toBe(1);

    const call = nodesOf(graph).find((node) => node.type === IR_CALL_KNOWN_FUNCTION)!;
    expect(calleeSymbolName(call)).toBe(NUMBER_OF_FUNCTION);
  });

  it("leaves a graph that reads no numbers alone", () => {
    const graph = measuringGraph("measures");

    expect(lowerParseNumbers(graph)).toBe(0);
  });

  it("is idempotent", () => {
    const graph = readingGraph("reads", PARSE_FLOAT_BUILTIN);

    expect(lowerParseNumbers(graph)).toBe(1);
    expect(lowerParseNumbers(graph)).toBe(0);
  });
});

describe("marking the prelude's own reads as counting bytes", () => {
  it("marks every character count inside a reader", () => {
    const reader = [...NUMBER_TEXT_READERS][0]!;
    const graph = measuringGraph(reader);

    expect(markNumberTextBytewise(createModuleIR([createCompilationUnit(graph)]))).toBe(2);

    for (const node of nodesOf(graph)) {
      if (node.type !== IR_CALL_BUILTIN) continue;
      expect(node.props[BYTEWISE_PROP]).toBe(true);
      expect(countsCharacters(node)).toBe(false);
    }
  });

  it("leaves a function that is not a reader alone", () => {
    const graph = measuringGraph("counts");

    expect(markNumberTextBytewise(createModuleIR([createCompilationUnit(graph)]))).toBe(0);

    for (const node of nodesOf(graph)) {
      expect(node.props[BYTEWISE_PROP]).toBeUndefined();
    }
  });
});
