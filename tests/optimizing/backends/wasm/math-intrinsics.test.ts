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
  REP_FLOAT64,
  REP_HANDLE,
} from "../../../../src/optimizing/types/representation.js";
import type { RegisterCompiledFunction } from "../../../../src/bytecode/register/compiler.js";

beforeEach(() => resetIRNodeIds());

const compiledStub = {
  name: "subject",
  paramCount: 0,
  instructions: [],
  upvalues: [],
} as unknown as RegisterCompiledFunction;

const analyzeFloorOf = (dividendRep: string) => {
  const graph = new CFGFunction("subject");
  const block = graph.addBlock();
  const left = irConstant(8);
  const right = irConstant(16);
  const quotient = irGenericDiv(left, right);
  quotient.props._rep = dividendRep;
  const floor = irCallBuiltin("Math.floor", [quotient], { _rep: REP_FLOAT64 });
  block.addNode(left);
  block.addNode(right);
  block.addNode(quotient);
  block.addNode(floor);
  block.addNode(irReturn(floor));
  graph.rebuildUses();

  const codegen = new WasmCodegen();
  const analysis = codegen.analyzeGraph(graph, compiledStub);
  expect(analysis).not.toBeNull();
  return { analysis: analysis!, floorId: floor.id };
};

describe("Math intrinsics are only inlined over raw numeric operands", () => {
  it("inlines the wasm opcode when the operand is a raw double", () => {
    const { analysis, floorId } = analyzeFloorOf(REP_FLOAT64);
    expect(analysis.mathCallIntrinsics.has(floorId)).toBe(true);
    expect(analysis.runtimeStubTable.byNodeId.has(floorId)).toBe(false);
  });

  it("falls back to a runtime stub when the operand is a boxed handle", () => {
    const { analysis, floorId } = analyzeFloorOf(REP_HANDLE);
    expect(analysis.mathCallIntrinsics.has(floorId)).toBe(false);
    expect(analysis.runtimeStubTable.byNodeId.has(floorId)).toBe(true);
  });
});
