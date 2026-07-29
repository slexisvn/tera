import { describe, it, expect, beforeEach } from "vitest";
import { inlineCacheLowering } from "../../src/optimizing/passes/ic-lowering.js";
import {
  CFGFunction,
  irConstant,
  irReturn,
  irPolymorphicLoad,
  irPolymorphicStore,
  IR_POLYMORPHIC_LOAD,
  IR_POLYMORPHIC_STORE,
  IR_DISPATCH_MAP,
  IR_MEGAMORPHIC_LOAD,
  IR_MEGAMORPHIC_STORE,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

function makeHandlers(count, hitCounts = null) {
  return Array.from({ length: count }, (_, i) => ({
    mapId: i + 1,
    offset: i * 4,
    hitCount: hitCounts ? hitCounts[i] : 10,
  }));
}

describe("inlineCacheLowering", () => {
  describe("polymorphic load", () => {
    it("lowers to IR_DISPATCH_MAP when handler count >= 2", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irConstant("obj");
      block.addNode(obj);
      const load = irPolymorphicLoad(obj, [1, 2], [0, 4]);
      load.props.handlers = makeHandlers(3);
      load.props.propertyName = "x";
      block.addNode(load);
      block.addNode(irReturn(load));

      const count = inlineCacheLowering(graph);

      expect(count).toBe(1);
      const dispatched = block.nodes.find(n => n.type === IR_DISPATCH_MAP);
      expect(dispatched).toBeDefined();
      expect(dispatched.props.propertyName).toBe("x");
      expect(dispatched.props.handlers).toHaveLength(3);
    });

    it("lowers to IR_MEGAMORPHIC_LOAD when handler count > 6", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irConstant("obj");
      block.addNode(obj);
      const load = irPolymorphicLoad(obj, [1], [0]);
      load.props.handlers = makeHandlers(7);
      load.props.propertyName = "y";
      block.addNode(load);
      block.addNode(irReturn(load));

      const count = inlineCacheLowering(graph);

      expect(count).toBe(1);
      expect(block.nodes.some(n => n.type === IR_MEGAMORPHIC_LOAD)).toBe(true);
      expect(block.nodes.some(n => n.type === IR_POLYMORPHIC_LOAD)).toBe(false);
    });

    it("leaves unchanged when handler count < 2", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irConstant("obj");
      block.addNode(obj);
      const load = irPolymorphicLoad(obj, [1], [0]);
      load.props.handlers = makeHandlers(1);
      load.props.propertyName = "z";
      block.addNode(load);
      block.addNode(irReturn(load));

      const count = inlineCacheLowering(graph);

      expect(count).toBe(0);
      expect(block.nodes.some(n => n.type === IR_POLYMORPHIC_LOAD)).toBe(true);
    });
  });

  describe("polymorphic store", () => {
    it("lowers to IR_DISPATCH_MAP with isStore for stores", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irConstant("obj");
      const val = irConstant(42);
      block.addNode(obj);
      block.addNode(val);
      const store = irPolymorphicStore(obj, [1, 2], [0, 4], val);
      store.props.handlers = makeHandlers(2);
      store.props.propertyName = "x";
      block.addNode(store);
      block.addNode(irReturn(irConstant(0)));

      const count = inlineCacheLowering(graph);

      expect(count).toBe(1);
      const dispatched = block.nodes.find(n => n.type === IR_DISPATCH_MAP);
      expect(dispatched).toBeDefined();
      expect(dispatched.props.isStore).toBe(true);
    });

    it("lowers to IR_MEGAMORPHIC_STORE when > 6 handlers", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irConstant("obj");
      const val = irConstant(42);
      block.addNode(obj);
      block.addNode(val);
      const store = irPolymorphicStore(obj, [1], [0], val);
      store.props.handlers = makeHandlers(7);
      store.props.propertyName = "w";
      block.addNode(store);
      block.addNode(irReturn(irConstant(0)));

      const count = inlineCacheLowering(graph);

      expect(count).toBe(1);
      expect(block.nodes.some(n => n.type === IR_MEGAMORPHIC_STORE)).toBe(true);
    });
  });

  describe("handler sorting and dominant detection", () => {
    it("sorts handlers by frequency (highest hitCount first)", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irConstant("obj");
      block.addNode(obj);
      const load = irPolymorphicLoad(obj, [1, 2, 3], [0, 4, 8]);
      load.props.handlers = [
        { mapId: 1, offset: 0, hitCount: 5 },
        { mapId: 2, offset: 4, hitCount: 100 },
        { mapId: 3, offset: 8, hitCount: 20 },
      ];
      load.props.propertyName = "x";
      block.addNode(load);
      block.addNode(irReturn(load));

      inlineCacheLowering(graph);

      const dispatched = block.nodes.find(n => n.type === IR_DISPATCH_MAP);
      expect(dispatched.props.handlers[0].hitCount).toBe(100);
      expect(dispatched.props.handlers[1].hitCount).toBe(20);
      expect(dispatched.props.handlers[2].hitCount).toBe(5);
    });

    it("detects dominant handler when one has >= 80% of hits", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irConstant("obj");
      block.addNode(obj);
      const load = irPolymorphicLoad(obj, [1, 2], [0, 4]);
      load.props.handlers = [
        { mapId: 1, offset: 0, hitCount: 90 },
        { mapId: 2, offset: 4, hitCount: 10 },
      ];
      load.props.propertyName = "x";
      block.addNode(load);
      block.addNode(irReturn(load));

      inlineCacheLowering(graph);

      const dispatched = block.nodes.find(n => n.type === IR_DISPATCH_MAP);
      expect(dispatched.props.dominant).toBeDefined();
      expect(dispatched.props.dominant.mapId).toBe(1);
    });

    it("no dominant when hits are evenly distributed", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const obj = irConstant("obj");
      block.addNode(obj);
      const load = irPolymorphicLoad(obj, [1, 2, 3], [0, 4, 8]);
      load.props.handlers = [
        { mapId: 1, offset: 0, hitCount: 34 },
        { mapId: 2, offset: 4, hitCount: 33 },
        { mapId: 3, offset: 8, hitCount: 33 },
      ];
      load.props.propertyName = "x";
      block.addNode(load);
      block.addNode(irReturn(load));

      inlineCacheLowering(graph);

      const dispatched = block.nodes.find(n => n.type === IR_DISPATCH_MAP);
      expect(dispatched.props.dominant).toBeNull();
    });
  });

  it("preserves id, inputs, uses, and frameState from original node", () => {
    const graph = new CFGFunction("test");
    const block = graph.addBlock();
    const obj = irConstant("obj");
    block.addNode(obj);
    const load = irPolymorphicLoad(obj, [1, 2], [0, 4]);
    load.props.handlers = makeHandlers(3);
    load.props.propertyName = "x";
    load.frameState = { localValues: new Map(), stackValues: [], thisValue: null };
    const originalId = load.id;
    block.addNode(load);
    const ret = irReturn(load);
    block.addNode(ret);

    inlineCacheLowering(graph);

    const dispatched = block.nodes.find(n => n.type === IR_DISPATCH_MAP);
    expect(dispatched.id).toBe(originalId);
    expect(dispatched.frameState).toBeDefined();
    expect(ret.inputs[0]).toBe(dispatched);
  });
});
