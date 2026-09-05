import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallBuiltin,
  irConstant,
  irJump,
  irReturn,
  resetIRNodeIds,
  IR_CALL_BUILTIN,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicByName,
  qualifiedMethodName,
  STRING_TYPE,
} from "../../../src/optimizing/metadata/builtin-methods.js";
import { BYTEWISE_PROP } from "../../../src/optimizing/analyses/wide-text.js";
import { faultOutsideBuiltinDomains } from "../../../src/optimizing/passes/builtin-domains.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";

beforeEach(() => resetIRNodeIds());

const CHAR_CODE_AT = qualifiedMethodName(STRING_TYPE, "char_code_at");
const LENGTH = qualifiedMethodName(STRING_TYPE, "length");

function call(name: string, inputs: readonly CFGInstruction[]): CFGInstruction {
  const intrinsic = builtinMethodIntrinsicByName(name)!;
  return irCallBuiltin(name, [...inputs], builtinMethodCallMetadata(intrinsic));
}

function graphReading(bytewise: boolean): CFGFunction {
  const graph = new CFGFunction("reads");
  graph.declaredSignature = { params: ["string"], returns: "int" };
  const block = graph.addBlock();
  const text = graph.addParameter(0);
  block.addNode(text);
  const index = irConstant(0);
  block.addNode(index);
  const read = call(CHAR_CODE_AT, [text, index]);
  if (bytewise) read.props[BYTEWISE_PROP] = true;
  block.addNode(read);
  block.addNode(irReturn(read));
  graph.rebuildUses();
  return graph;
}

function graphMeasuringThenReading(counted: boolean, read: boolean): CFGFunction {
  const graph = new CFGFunction("reads");
  graph.declaredSignature = { params: ["string"], returns: "int" };
  const first = graph.addBlock();
  const second = graph.addBlock();
  link(first, second);
  const text = graph.addParameter(0);
  first.addNode(text);
  const measured = call(LENGTH, [text]);
  if (counted) measured.props[BYTEWISE_PROP] = true;
  first.addNode(measured);
  first.addNode(irJump(second));
  const index = irConstant(0);
  second.addNode(index);
  const taken = call(CHAR_CODE_AT, [text, index]);
  if (read) taken.props[BYTEWISE_PROP] = true;
  second.addNode(taken);
  second.addNode(irReturn(taken));
  graph.rebuildUses();
  return graph;
}

function bounds(graph: CFGFunction): CFGInstruction[] {
  return graph.blocks
    .flatMap((block) => [...block.nodes])
    .filter((node) => node.type === IR_CALL_BUILTIN && node.props.name === LENGTH);
}

describe("the bound a builtin's domain check measures", () => {
  it("counts the same units the read it guards counts", () => {
    for (const bytewise of [false, true]) {
      const graph = graphReading(bytewise);

      expect(faultOutsideBuiltinDomains(graph)).toBe(1);

      const measured = bounds(graph);
      expect(measured.length).toBe(1);
      expect(measured[0]!.props[BYTEWISE_PROP] === true).toBe(bytewise);
    }
  });

  it("reuses a count already taken over the same units", () => {
    for (const bytewise of [false, true]) {
      const graph = graphMeasuringThenReading(bytewise, bytewise);

      faultOutsideBuiltinDomains(graph);

      expect(bounds(graph).length).toBe(1);
    }
  });

  it("takes its own count rather than one over the other units", () => {
    for (const bytewise of [false, true]) {
      const graph = graphMeasuringThenReading(!bytewise, bytewise);

      faultOutsideBuiltinDomains(graph);

      const measured = bounds(graph);
      expect(measured.length).toBe(2);
      expect(measured.filter((node) => node.props[BYTEWISE_PROP] === true).length).toBe(1);
    }
  });
});
