import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  CFGInstruction,
  IR_DISPATCH_MAP,
  irCallBuiltin,
  irConstant,
  irLoadField,
  irLoadGlobal,
  irNewObject,
  irReturn,
  irStoreField,
  irStoreGlobal,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { modRefAnalysisId } from "../../../src/optimizing/analyses/mod-ref.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry } from "../../../src/optimizing/analyses/index.js";

beforeEach(() => resetIRNodeIds());

function analyze(build: (graph: CFGFunction, block: ReturnType<CFGFunction["addBlock"]>) => void) {
  const graph = new CFGFunction("modref");
  const block = graph.addBlock();
  build(graph, block);
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return { graph, block, modRef: analyses.get(modRefAnalysisId) };
}

describe("ModRef region write sets", () => {
  it("reports the locations a region writes", () => {
    let store!: CFGInstruction;
    const { graph, modRef } = analyze((_g, block) => {
      const obj = irNewObject();
      const value = irConstant(1);
      store = irStoreField(obj, 0, value);
      block.addNode(obj);
      block.addNode(value);
      block.addNode(store);
      block.addNode(irReturn(obj));
    });

    const region = modRef.writesOf(graph.blocks);
    expect(region.clobbersEverything).toBe(false);
    expect(region.locations).toHaveLength(1);
    expect(region.locations[0].key).toBe(modRef.locationOf(store)!.key);
  });

  it("marks a region containing an unknown call as clobbering everything", () => {
    const { graph, modRef } = analyze((_g, block) => {
      const callee = irConstant(1);
      block.addNode(callee);
      block.addNode(irCallBuiltin("unknown", [callee]));
      block.addNode(irReturn(callee));
    });

    expect(modRef.writesOf(graph.blocks).clobbersEverything).toBe(true);
  });

  it("does not treat a declared immutable-read builtin as a clobber", () => {
    const { graph, modRef } = analyze((_g, block) => {
      const receiver = irConstant("s");
      block.addNode(receiver);
      const call = irCallBuiltin("string.length", [receiver], {
        declaredEffects: ["immutable-read"],
      });
      block.addNode(call);
      block.addNode(irReturn(call));
    });

    expect(modRef.writesOf(graph.blocks).clobbersEverything).toBe(false);
  });

  it("treats a dispatch-map store as clobbering tracked memory", () => {
    const { graph, modRef } = analyze((_g, block) => {
      const obj = irNewObject();
      block.addNode(obj);
      const dispatch = new CFGInstruction(IR_DISPATCH_MAP, { isStore: true });
      dispatch.addInput(obj);
      block.addNode(dispatch);
      block.addNode(irReturn(obj));
    });

    expect(modRef.writesOf(graph.blocks).clobbersEverything).toBe(true);
  });
});

describe("ModRef read dependence", () => {
  it("says a field load may read a region that writes the same field", () => {
    let load!: CFGInstruction;
    const { graph, modRef } = analyze((_g, block) => {
      const obj = irNewObject();
      const value = irConstant(1);
      block.addNode(obj);
      block.addNode(value);
      block.addNode(irStoreField(obj, 0, value));
      load = irLoadField(obj, 0);
      block.addNode(load);
      block.addNode(irReturn(load));
    });

    expect(modRef.mayReadFrom(load, modRef.writesOf(graph.blocks))).toBe(true);
  });

  it("says a field load ignores a region that writes a different field", () => {
    let load!: CFGInstruction;
    const { graph, modRef } = analyze((_g, block) => {
      const obj = irNewObject();
      const value = irConstant(1);
      block.addNode(obj);
      block.addNode(value);
      block.addNode(irStoreField(obj, 8, value));
      load = irLoadField(obj, 0);
      block.addNode(load);
      block.addNode(irReturn(load));
    });

    expect(modRef.mayReadFrom(load, modRef.writesOf(graph.blocks))).toBe(false);
  });

  it("says a global load depends on a write to the same global only", () => {
    let sameName!: CFGInstruction;
    let otherName!: CFGInstruction;
    const { graph, modRef } = analyze((_g, block) => {
      const value = irConstant(1);
      block.addNode(value);
      block.addNode(irStoreGlobal("counter", value));
      sameName = irLoadGlobal("counter");
      otherName = irLoadGlobal("other");
      block.addNode(sameName);
      block.addNode(otherName);
      block.addNode(irReturn(sameName));
    });

    const region = modRef.writesOf(graph.blocks);
    expect(modRef.mayReadFrom(sameName, region)).toBe(true);
    expect(modRef.mayReadFrom(otherName, region)).toBe(false);
  });

  it("says nothing reads from an empty region", () => {
    let load!: CFGInstruction;
    const { modRef } = analyze((_g, block) => {
      const obj = irNewObject();
      block.addNode(obj);
      load = irLoadField(obj, 0);
      block.addNode(load);
      block.addNode(irReturn(load));
    });

    expect(
      modRef.mayReadFrom(load, { clobbersEverything: false, locations: [], keys: new Set() }),
    ).toBe(false);
  });

  it("says a pure computation never reads a clobbering region", () => {
    let value!: CFGInstruction;
    const { modRef } = analyze((_g, block) => {
      value = irConstant(7);
      block.addNode(value);
      block.addNode(irReturn(value));
    });

    expect(
      modRef.mayReadFrom(value, { clobbersEverything: true, locations: [], keys: new Set() }),
    ).toBe(false);
  });
});
