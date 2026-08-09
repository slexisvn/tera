import { describe, it, expect, beforeEach } from "vitest";
import { deadStoreElimination } from "../../src/optimizing/passes/dead-stores.js";
import { AnalysisManager } from "../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry, modRefAnalysisId, pointsToAnalysisId } from "../../src/optimizing/analyses/index.js";
import {
  CFGFunction,
  irConstant,
  irNewObject,
  irStoreField,
  irLoadField,
  irGenericCall,
  irGenericGetProp,
  irGenericSetProp,
  irReturn,
  irJump,
  IR_STORE_FIELD,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";
import { link } from "../../src/optimizing/ir/cfg-edit.js";

beforeEach(() => resetIRNodeIds());

function eliminateDeadStores(graph: CFGFunction): number {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return deadStoreElimination(
    graph,
    analyses.get(pointsToAnalysisId),
    analyses.get(modRefAnalysisId),
  );
}

describe("deadStoreElimination", () => {
  describe("intra-block elimination", () => {
    it("eliminates store overwritten by later store to same object:offset", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irNewObject();
      block.addNode(obj);
      const v1 = irConstant(1);
      const v2 = irConstant(2);
      block.addNode(v1);
      block.addNode(v2);
      block.addNode(irStoreField(obj, 0, v1));
      block.addNode(irStoreField(obj, 0, v2));
      block.addNode(irReturn(obj));

      const count = eliminateDeadStores(graph);

      expect(count).toBeGreaterThanOrEqual(1);
      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(1);
      expect(stores[0].inputs[1]).toBe(v2);
    });

    it("keeps store when a load of same key appears between stores", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irNewObject();
      block.addNode(obj);
      const v1 = irConstant(1);
      const v2 = irConstant(2);
      block.addNode(v1);
      block.addNode(v2);
      block.addNode(irStoreField(obj, 0, v1));
      const load = irLoadField(obj, 0);
      block.addNode(load);
      block.addNode(irStoreField(obj, 0, v2));
      block.addNode(irReturn(load));

      eliminateDeadStores(graph);

      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(1);
      expect(stores[0].inputs[1]).toBe(v1);
    });

    it("invalidates tracking after a call (store before call is not dead)", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = graph.addParameter(0);
      const v1 = irConstant(1);
      block.addNode(v1);
      block.addNode(irStoreField(obj, 0, v1));
      const callee = irConstant("fn");
      block.addNode(callee);
      block.addNode(irGenericCall(callee, []));
      block.addNode(irReturn(irConstant(0)));

      eliminateDeadStores(graph);

      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(1);
    });

    it("keeps local store before generic property read on the same object", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irNewObject();
      block.addNode(obj);
      const value = irConstant(1);
      block.addNode(value);
      block.addNode(irStoreField(obj, 0, value));
      block.addNode(irGenericGetProp(obj, "x"));
      block.addNode(irReturn(irConstant(0)));

      const count = eliminateDeadStores(graph);

      expect(count).toBe(0);
      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(1);
    });

    it("keeps local store before generic property write on the same object", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irNewObject();
      block.addNode(obj);
      const v1 = irConstant(1);
      const v2 = irConstant(2);
      block.addNode(v1);
      block.addNode(v2);
      block.addNode(irStoreField(obj, 0, v1));
      block.addNode(irGenericSetProp(obj, "x", v2));
      block.addNode(irReturn(irConstant(0)));

      const count = eliminateDeadStores(graph);

      expect(count).toBe(0);
      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(1);
    });

    it("different offsets are tracked independently", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irNewObject();
      block.addNode(obj);
      const v1 = irConstant(1);
      const v2 = irConstant(2);
      block.addNode(v1);
      block.addNode(v2);
      block.addNode(irStoreField(obj, 0, v1));
      block.addNode(irStoreField(obj, 4, v2));
      const load = irLoadField(obj, 0);
      block.addNode(load);
      block.addNode(irReturn(load));

      eliminateDeadStores(graph);

      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(1);
      expect(stores[0].inputs[1]).toBe(v1);
    });
  });

  describe("cross-block elimination", () => {
    it("eliminates store when all successors overwrite same key", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const b1 = graph.addBlock();
      const b2 = graph.addBlock();

      const obj = irNewObject();
      b0.addNode(obj);
      const v1 = irConstant(1);
      b0.addNode(v1);
      b0.addNode(irStoreField(obj, 0, v1));
      link(b0, b1);
      link(b0, b2);
      b0.addNode(irJump(b1));

      const v2 = irConstant(2);
      b1.addNode(v2);
      b1.addNode(irStoreField(obj, 0, v2));
      b1.addNode(irReturn(irConstant(0)));

      const v3 = irConstant(3);
      b2.addNode(v3);
      b2.addNode(irStoreField(obj, 0, v3));
      b2.addNode(irReturn(irConstant(0)));

      const count = eliminateDeadStores(graph);

      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("does NOT eliminate when a successor reads before overwriting", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const b1 = graph.addBlock();

      const obj = irNewObject();
      b0.addNode(obj);
      const v1 = irConstant(1);
      b0.addNode(v1);
      b0.addNode(irStoreField(obj, 0, v1));
      link(b0, b1);
      b0.addNode(irJump(b1));

      const load = irLoadField(obj, 0);
      b1.addNode(load);
      const v2 = irConstant(2);
      b1.addNode(v2);
      b1.addNode(irStoreField(obj, 0, v2));
      b1.addNode(irReturn(load));

      eliminateDeadStores(graph);

      const b0Stores = b0.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(b0Stores).toHaveLength(1);
    });

    it("does NOT eliminate when a successor has a call before the overwriting store", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const b1 = graph.addBlock();

      const obj = irNewObject();
      b0.addNode(obj);
      const v1 = irConstant(1);
      b0.addNode(v1);
      b0.addNode(irStoreField(obj, 0, v1));
      link(b0, b1);
      b0.addNode(irJump(b1));

      b1.addNode(irGenericCall(irConstant(0), [obj]));
      const v2 = irConstant(2);
      b1.addNode(v2);
      b1.addNode(irStoreField(obj, 0, v2));
      b1.addNode(irReturn(irConstant(0)));

      eliminateDeadStores(graph);

      const b0Stores = b0.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(b0Stores).toHaveLength(1);
    });

    it("eliminates a store overwritten through multiple blocks on every path", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const b1 = graph.addBlock();
      const b2 = graph.addBlock();
      const b3 = graph.addBlock();

      const obj = irNewObject();
      const v1 = irConstant(1);
      b0.addNode(obj);
      b0.addNode(v1);
      b0.addNode(irStoreField(obj, 0, v1));
      link(b0, b1);
      b0.addNode(irJump(b1));

      link(b1, b2);
      b1.addNode(irJump(b2));

      const v2 = irConstant(2);
      b2.addNode(v2);
      b2.addNode(irStoreField(obj, 0, v2));
      link(b2, b3);
      b2.addNode(irJump(b3));

      b3.addNode(irReturn(obj));

      const count = eliminateDeadStores(graph);

      expect(count).toBeGreaterThanOrEqual(1);
      const b0Stores = b0.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(b0Stores).toHaveLength(0);
    });
  });
});
