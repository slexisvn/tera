import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallBuiltin,
  irConstant,
  irGenericDiv,
  irReturn,
  resetIRNodeIds,
} from "../../../../src/optimizing/ir/index.js";
import { WasmCodegen } from "../../../../src/optimizing/backends/wasm/codegen.js";
import {
  abiRepresentationOf,
  REP_FLOAT64,
  REP_HANDLE,
  REP_INT32,
  REP_TAGGED_NUMBER,
} from "../../../../src/optimizing/types/representation.js";
import type { RegisterCompiledFunction } from "../../../../src/bytecode/register/compiler.js";

beforeEach(() => resetIRNodeIds());

const compiledStub = {
  name: "subject",
  paramCount: 0,
  instructions: [],
  upvalues: [],
} as unknown as RegisterCompiledFunction;

const analyzeReturnOf = (returnedRep: string, declaredRep: string) => {
  const graph = new CFGFunction("subject");
  graph.returnRepresentation = declaredRep as never;
  const block = graph.addBlock();
  const left = irConstant(899);
  const right = irConstant(10);
  const quotient = irGenericDiv(left, right);
  quotient.props._rep = REP_HANDLE;
  const floor = irCallBuiltin("Math.floor", [quotient], { _rep: returnedRep });
  block.addNode(left);
  block.addNode(right);
  block.addNode(quotient);
  block.addNode(floor);
  block.addNode(irReturn(floor));
  graph.rebuildUses();

  const analysis = new WasmCodegen().analyzeGraph(graph, compiledStub);
  expect(analysis).not.toBeNull();
  return analysis!.resultValueRep;
};

describe("the wasm result ABI describes what the returns actually produce", () => {
  it("answers a raw number when the return is a raw number, whatever the graph declares", () => {
    expect(abiRepresentationOf(REP_INT32)).toBe(REP_TAGGED_NUMBER);
    expect(analyzeReturnOf(REP_INT32, REP_HANDLE)).toBe(REP_TAGGED_NUMBER);
    expect(analyzeReturnOf(REP_FLOAT64, REP_HANDLE)).toBe(REP_TAGGED_NUMBER);
  });

  it("answers a handle when the return really is one", () => {
    expect(analyzeReturnOf(REP_HANDLE, REP_HANDLE)).toBe(REP_HANDLE);
  });
});
