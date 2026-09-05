import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  IR_CALL_BUILTIN,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  builtinGlobalIntrinsicByName,
  NUMBER_BUILTIN,
  PARSE_FLOAT_BUILTIN,
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
