import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCheckBounds,
  irCheckMap,
  irCheckSmi,
  irConstant,
  irInt32Add,
  irReturn,
  resetIRNodeIds,
} from "../../../../src/optimizing/ir/index.js";
import { FrameState } from "../../../../src/deopt/frame-state.js";
import { collectDeoptSites } from "../../../../src/optimizing/backends/wasm/deopt-sites.js";
import {
  DEOPT_BOUNDS_CHECK_FAILED,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_SMI_CHECK_FAILED,
} from "../../../../src/deopt/deoptimizer.js";

beforeEach(() => resetIRNodeIds());

function framed<T extends { frameState: FrameState | null }>(node: T, id: number): T {
  const state = new FrameState(null, id * 10);
  state.id = id;
  node.frameState = state;
  return node;
}

describe("collectDeoptSites", () => {
  it("records one site per node that can bail out, and skips the ones that cannot", () => {
    const graph = new CFGFunction("guarded");
    const block = graph.addBlock();
    const index = irConstant(1);
    const array = irConstant(2);
    block.addNode(index);
    block.addNode(array);
    const check = framed(irCheckBounds(index, array), 0);
    block.addNode(check);
    block.addNode(irReturn(check));

    const table = collectDeoptSites(graph);

    expect(table.sites.map((site) => site.opcode)).toEqual(["CheckBounds"]);
    expect(table.sites[0]).toMatchObject({
      nodeId: check.id,
      reason: DEOPT_BOUNDS_CHECK_FAILED,
      frameStateId: 0,
      bytecodeOffset: 0,
      blockId: block.id,
    });
  });

  it("resolves a bailout to the single guard that shares its frame state and reason", () => {
    const graph = new CFGFunction("two-guards");
    const block = graph.addBlock();
    const value = irConstant(7);
    block.addNode(value);
    const smi = framed(irCheckSmi(value), 1);
    const map = framed(irCheckMap(value, 3), 1);
    block.addNode(smi);
    block.addNode(map);
    block.addNode(irReturn(map));

    const table = collectDeoptSites(graph);

    expect(table.resolve(DEOPT_MAP_CHECK_FAILED, 1).map((site) => site.nodeId)).toEqual([map.id]);
    expect(table.resolve(DEOPT_SMI_CHECK_FAILED, 1).map((site) => site.nodeId)).toEqual([smi.id]);
  });

  it("returns every guard sharing a frame state when the reason does not single one out", () => {
    const graph = new CFGFunction("shared-frame");
    const block = graph.addBlock();
    const value = irConstant(7);
    block.addNode(value);
    const state = new FrameState(null, 0);
    state.id = 4;
    const smi = irCheckSmi(value);
    const map = irCheckMap(value, 3);
    smi.frameState = state;
    map.frameState = state;
    block.addNode(smi);
    block.addNode(map);
    block.addNode(irReturn(map));

    const table = collectDeoptSites(graph);

    expect(table.resolve("no-such-reason", 4).map((site) => site.nodeId)).toEqual([
      smi.id,
      map.id,
    ]);
  });

  it("falls back to matching on reason alone when the frame state is unknown", () => {
    const graph = new CFGFunction("unknown-frame");
    const block = graph.addBlock();
    const value = irConstant(7);
    block.addNode(value);
    const smi = framed(irCheckSmi(value), 2);
    block.addNode(smi);
    block.addNode(irReturn(smi));

    const table = collectDeoptSites(graph);

    expect(table.resolve(DEOPT_SMI_CHECK_FAILED, -1).map((site) => site.nodeId)).toEqual([smi.id]);
    expect(table.resolve(DEOPT_MAP_CHECK_FAILED, -1)).toEqual([]);
  });

  it("finds nothing in a graph whose arithmetic was proven not to overflow", () => {
    const graph = new CFGFunction("safe");
    const block = graph.addBlock();
    const left = irConstant(1);
    const right = irConstant(2);
    block.addNode(left);
    block.addNode(right);
    const sum = irInt32Add(left, right);
    sum.props.noOverflow = true;
    block.addNode(sum);
    block.addNode(irReturn(sum));

    expect(collectDeoptSites(graph).sites).toEqual([]);
  });
});
