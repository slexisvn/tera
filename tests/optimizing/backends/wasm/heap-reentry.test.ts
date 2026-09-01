import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCheckArray,
  irConstant,
  irGenericCall,
  irLoadElement,
  irLoadGlobal,
  irReturn,
  irStoreElement,
  resetIRNodeIds,
} from "../../../../src/optimizing/ir/index.js";
import { WasmCodegen } from "../../../../src/optimizing/backends/wasm/codegen.js";
import { REP_HANDLE, REP_INT32 } from "../../../../src/optimizing/types/representation.js";
import type { RegisterCompiledFunction } from "../../../../src/bytecode/register/compiler.js";

beforeEach(() => resetIRNodeIds());

const compiledStub = {
  name: "subject",
  paramCount: 0,
  instructions: [],
  upvalues: [],
} as unknown as RegisterCompiledFunction;

const analyzeTouching = (options: { callsOut: boolean }) => {
  const graph = new CFGFunction("subject");
  const block = graph.addBlock();
  const array = irLoadGlobal("cells");
  array.props._rep = REP_HANDLE;
  const checked = irCheckArray(array);
  checked.props._rep = REP_HANDLE;
  const index = irConstant(0);
  index.props._rep = REP_INT32;
  const load = irLoadElement(checked, index);
  load.props._rep = REP_INT32;
  const store = irStoreElement(checked, index, load);

  block.addNode(array);
  block.addNode(checked);
  block.addNode(index);
  block.addNode(load);
  if (options.callsOut) {
    const callee = irLoadGlobal("put");
    callee.props._rep = REP_HANDLE;
    const call = irGenericCall(callee, [index]);
    call.props._rep = REP_HANDLE;
    block.addNode(callee);
    block.addNode(call);
  }
  block.addNode(store);
  block.addNode(irReturn(load));
  graph.rebuildUses();

  const analysis = new WasmCodegen().analyzeGraph(graph, compiledStub);
  expect(analysis).not.toBeNull();
  return {
    stubbed: (id: number) => analysis!.runtimeStubTable.byNodeId.has(id),
    mutatesHeapObjects: analysis!.mutatesHeapObjects,
    loadId: load.id,
    storeId: store.id,
  };
};

describe("heap accesses in a function that re-enters the interpreter", () => {
  it("reads and writes wasm memory directly when nothing can call out", () => {
    const { stubbed, mutatesHeapObjects, loadId, storeId } = analyzeTouching({
      callsOut: false,
    });

    expect(stubbed(loadId)).toBe(false);
    expect(stubbed(storeId)).toBe(false);
    expect(mutatesHeapObjects).toBe(true);
  });

  it("goes through runtime stubs once a call can mutate the same object", () => {
    const { stubbed, mutatesHeapObjects, loadId, storeId } = analyzeTouching({
      callsOut: true,
    });

    expect(stubbed(loadId)).toBe(true);
    expect(stubbed(storeId)).toBe(true);
    expect(mutatesHeapObjects).toBe(false);
  });
});
