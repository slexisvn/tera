import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  IR_CALL_BUILTIN,
  IR_GENERIC_ADD,
  IR_GENERIC_CALL,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  builtinGlobalIntrinsicByName,
  CHAR_FROM_CODE_BUILTIN,
  FROM_CHAR_CODE_MEMBER,
  NUMBER_BUILTIN,
  PARSE_FLOAT_BUILTIN,
  STRING_BUILTIN,
  WHOLE_TEXT_PROP,
} from "../../../src/optimizing/metadata/builtin-methods.js";
import { lowerGlobalBuiltins } from "../../../src/optimizing/passes/global-builtin-lowering.js";

beforeEach(() => resetIRNodeIds());

const PARSE_FLOAT_CALL = builtinGlobalIntrinsicByName(PARSE_FLOAT_BUILTIN)!.qualifiedName;

function calling(builtin: string, held: string | number): {
  graph: CFGFunction;
  value: CFGInstruction;
} {
  const graph = new CFGFunction("read");
  graph.declaredSignature = { params: [], returns: "float" };
  const block = graph.addBlock();
  const value = block.addNode(irConstant(held));
  const call = block.addNode(irGenericCall(block.addNode(irLoadGlobal(builtin)), [value]));
  block.addNode(irReturn(call));
  graph.rebuildUses();
  return { graph, value };
}

function lower(graph: CFGFunction): number {
  const types = new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId);
  const lowered = lowerGlobalBuiltins(graph, types);
  graph.rebuildUses();
  return lowered;
}

function builtinCalls(graph: CFGFunction): CFGInstruction[] {
  return graph.blocks.flatMap((block) =>
    block.nodes.filter((node) => node.type === IR_CALL_BUILTIN),
  );
}

describe("lowering the number builtins a program calls by name", () => {
  it("reads text with the parse-float builtin", () => {
    const { graph } = calling(NUMBER_BUILTIN, "12.5");

    expect(lower(graph)).toBe(1);
    expect(builtinCalls(graph).map((call) => call.props.name)).toEqual([PARSE_FLOAT_CALL]);
  });

  it("marks that call as reading the whole text, the way Number does", () => {
    const { graph } = calling(NUMBER_BUILTIN, "12.5");
    lower(graph);

    expect(builtinCalls(graph)[0]!.props[WHOLE_TEXT_PROP]).toBe(true);
  });

  it("leaves a direct parse-float call reading only the number it leads with", () => {
    const { graph } = calling(PARSE_FLOAT_BUILTIN, "12.5px");
    lower(graph);

    expect(builtinCalls(graph).map((call) => call.props.name)).toEqual([PARSE_FLOAT_CALL]);
    expect(builtinCalls(graph)[0]!.props[WHOLE_TEXT_PROP]).toBeUndefined();
  });

  it("drops the call altogether when the value is already a number", () => {
    const { graph, value } = calling(NUMBER_BUILTIN, 3);

    expect(lower(graph)).toBe(1);
    expect(builtinCalls(graph)).toEqual([]);
    expect(graph.blocks[0]!.nodes.at(-1)!.inputs[0]).toBe(value);
  });
});

const CHAR_FROM_CODE_CALL = builtinGlobalIntrinsicByName(CHAR_FROM_CODE_BUILTIN)!.qualifiedName;

function spelling(member: string, ...codes: number[]): CFGFunction {
  const graph = new CFGFunction("spell");
  graph.declaredSignature = { params: [], returns: "string" };
  const block = graph.addBlock();
  const namespace = block.addNode(irLoadGlobal(STRING_BUILTIN));
  const callee = block.addNode(irGenericGetProp(namespace, member));
  const call = block.addNode(
    irGenericCall(callee, [namespace, ...codes.map((code) => block.addNode(irConstant(code)))]),
  );
  call.props.isMethod = true;
  block.addNode(irReturn(call));
  graph.rebuildUses();
  return graph;
}

const opcodesIn = (graph: CFGFunction): string[] =>
  graph.blocks.flatMap((block) => block.nodes.map((node) => node.type));

describe("lowering a character spelled out from its code", () => {
  it("spells one code with the character builtin", () => {
    const graph = spelling(FROM_CHAR_CODE_MEMBER, 65);

    expect(lower(graph)).toBe(1);
    expect(builtinCalls(graph).map((call) => call.props.name)).toEqual([CHAR_FROM_CODE_CALL]);
  });

  it("leaves no generic call behind for a backend to refuse", () => {
    const graph = spelling(FROM_CHAR_CODE_MEMBER, 65);
    lower(graph);

    expect(opcodesIn(graph)).not.toContain(IR_GENERIC_CALL);
  });

  it("joins several codes into one piece of text", () => {
    const graph = spelling(FROM_CHAR_CODE_MEMBER, 97, 98, 99);
    lower(graph);

    expect(builtinCalls(graph)).toHaveLength(3);
    expect(opcodesIn(graph).filter((type) => type === IR_GENERIC_ADD)).toHaveLength(2);
  });

  it("spells the code the program wrote, in the order it wrote them", () => {
    const graph = spelling(FROM_CHAR_CODE_MEMBER, 97, 98);
    lower(graph);

    expect(builtinCalls(graph).map((call) => call.inputs[0]!.props.value)).toEqual([97, 98]);
  });

  it("reads the member however the program spelled it", () => {
    const graph = spelling("from_char_code", 65);

    expect(lower(graph)).toBe(1);
    expect(builtinCalls(graph).map((call) => call.props.name)).toEqual([CHAR_FROM_CODE_CALL]);
  });

  it("leaves a member of that name on something other than String alone", () => {
    const graph = new CFGFunction("spell");
    const block = graph.addBlock();
    const held = block.addNode(irLoadGlobal("Buffer"));
    const call = block.addNode(
      irGenericCall(block.addNode(irGenericGetProp(held, FROM_CHAR_CODE_MEMBER)), [
        held,
        block.addNode(irConstant(65)),
      ]),
    );
    call.props.isMethod = true;
    block.addNode(irReturn(call));
    graph.rebuildUses();

    expect(lower(graph)).toBe(0);
    expect(builtinCalls(graph)).toEqual([]);
  });

  it("leaves a call spelling no code at all alone", () => {
    const graph = spelling(FROM_CHAR_CODE_MEMBER);

    expect(lower(graph)).toBe(0);
    expect(builtinCalls(graph)).toEqual([]);
  });
});
