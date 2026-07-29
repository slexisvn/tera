import { describe, it, expect, beforeEach } from "vitest";
import { deadStoreElimination } from "../../src/optimizing/passes/dead-stores.js";
import {
  CFGFunction,
  irConstant,
  irNewObject,
  irStoreField,
  irLoadField,
  irGenericCall,
  irReturn,
  irJump,
  IR_STORE_FIELD,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

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
      block.addNode(irReturn(irConstant(0)));

      const count = deadStoreElimination(graph);

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

      const count = deadStoreElimination(graph);

      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(2);
    });

    it("invalidates tracking after a call (store before call is not dead)", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irNewObject();
      block.addNode(obj);
      const v1 = irConstant(1);
      const v2 = irConstant(2);
      block.addNode(v1);
      block.addNode(v2);
      block.addNode(irStoreField(obj, 0, v1));
      const callee = irConstant("fn");
      block.addNode(callee);
      block.addNode(irGenericCall(callee, []));
      block.addNode(irStoreField(obj, 0, v2));
      block.addNode(irReturn(irConstant(0)));

      deadStoreElimination(graph);

      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(2);
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
      block.addNode(irReturn(irConstant(0)));

      const count = deadStoreElimination(graph);

      const stores = block.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(stores).toHaveLength(2);
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
      b0.addSuccessor(b1);
      b0.addSuccessor(b2);
      b0.addNode(irJump(b1));

      const v2 = irConstant(2);
      b1.addNode(v2);
      b1.addNode(irStoreField(obj, 0, v2));
      b1.addNode(irReturn(irConstant(0)));

      const v3 = irConstant(3);
      b2.addNode(v3);
      b2.addNode(irStoreField(obj, 0, v3));
      b2.addNode(irReturn(irConstant(0)));

      const count = deadStoreElimination(graph);

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
      b0.addSuccessor(b1);
      b0.addNode(irJump(b1));

      const load = irLoadField(obj, 0);
      b1.addNode(load);
      const v2 = irConstant(2);
      b1.addNode(v2);
      b1.addNode(irStoreField(obj, 0, v2));
      b1.addNode(irReturn(load));

      const count = deadStoreElimination(graph);

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
      b0.addSuccessor(b1);
      b0.addNode(irJump(b1));

      b1.addNode(irGenericCall(irConstant(0), []));
      const v2 = irConstant(2);
      b1.addNode(v2);
      b1.addNode(irStoreField(obj, 0, v2));
      b1.addNode(irReturn(irConstant(0)));

      deadStoreElimination(graph);

      const b0Stores = b0.nodes.filter(n => n.type === IR_STORE_FIELD);
      expect(b0Stores).toHaveLength(1);
    });
  });
});
