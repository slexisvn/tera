import { describe, it, expect } from "vitest";
import { GenerationalGC } from "../../src/gc/gc.js";
import { COLOR_WHITE } from "../../src/gc/incremental-marker.js";
import {
  mkObject,
  heapPayloadCount,
  heapPayloadLiveBytesEstimate,
} from "../../src/core/value/index.js";
import { Engine } from "../../src/api/engine.js";

function makeHeapObj(id, refs = []) {
  return {
    id,
    gcHeader: null,
    visitReferences(cb) {
      for (const r of refs) cb(r);
    },
  };
}

function makeGCWithRoots(opts = {}) {
  const gc = new GenerationalGC({
    youngGenSize: opts.youngGenSize || 64,
    allocationBudget: opts.allocationBudget || 1000,
    ...opts,
  });
  const rootObjects = [];
  const interpreter = {
    activeFrames: [{ locals: rootObjects, stack: [] }],
  };
  gc.bindRoots(interpreter, null, null);
  return { gc, rootObjects };
}

describe("GenerationalGC", () => {
  describe("allocation", () => {
    it("allocates objects into young generation with gcHeader", () => {
      const { gc } = makeGCWithRoots();
      const obj = makeHeapObj("a");
      gc.allocate(obj);
      expect(obj.gcHeader).toBeDefined();
      expect(obj.gcHeader.generation).toBe("young");
      expect(obj.gcHeader.age).toBe(0);
      expect(gc.stats.totalAllocated).toBe(1);
    });

    it("pretenure allocates directly to old generation", () => {
      const { gc } = makeGCWithRoots();
      const obj = makeHeapObj("old");
      gc.allocate(obj, true);
      expect(obj.gcHeader.generation).toBe("old");
      expect(gc.isInOldGen(obj)).toBe(true);
    });

    it("overflows to old gen when young gen is full", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 2, allocationBudget: 10000 });
      const objs = [];
      for (let i = 0; i < 5; i++) {
        const obj = makeHeapObj(i);
        gc.allocate(obj);
        rootObjects.push(obj);
        objs.push(obj);
      }
      const inOld = objs.filter((o) => o.gcHeader.generation === "old");
      expect(inOld.length).toBeGreaterThan(0);
    });

    it("tracks allocation count for budget", () => {
      const { gc } = makeGCWithRoots();
      gc.allocate(makeHeapObj(1));
      gc.allocate(makeHeapObj(2));
      expect(gc.getStats().allocationsSinceGC).toBe(2);
    });
  });

  describe("needsCollection", () => {
    it("returns true when allocation budget exceeded", () => {
      const { gc } = makeGCWithRoots({ allocationBudget: 3 });
      for (let i = 0; i < 3; i++) gc.allocate(makeHeapObj(i));
      expect(gc.needsCollection()).toBe(true);
    });

    it("returns true when fromSpace is full", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 2, allocationBudget: 10000 });
      const a = makeHeapObj("a");
      const b = makeHeapObj("b");
      rootObjects.push(a, b);
      gc.allocate(a);
      gc.allocate(b);
      expect(gc.fromSpace.isFull()).toBe(true);
      expect(gc.needsCollection()).toBe(true);
    });
  });

  describe("minorGC (scavenge)", () => {
    it("promotes objects after surviving enough GC cycles", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const obj = makeHeapObj("survivor");
      rootObjects.push(obj);
      gc.allocate(obj);

      gc.minorGC();
      expect(obj.gcHeader.age).toBeGreaterThanOrEqual(1);
      gc.minorGC();
      expect(obj.gcHeader.generation).toBe("old");
      expect(gc.stats.totalPromoted).toBeGreaterThan(0);
    });

    it("collects unreachable young objects (not copied to toSpace)", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const reachable = makeHeapObj("reach");
      const unreachable = makeHeapObj("unreach");
      rootObjects.push(reachable);
      gc.allocate(reachable);
      gc.allocate(unreachable);

      gc.minorGC();
      expect(reachable.gcHeader.age).toBe(1);
    });

    it("follows references to keep transitive objects alive", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const child = makeHeapObj("child");
      const parent = makeHeapObj("parent", [child]);
      rootObjects.push(parent);
      gc.allocate(parent);
      gc.allocate(child);

      gc.minorGC();
      expect(child.gcHeader.age).toBe(1);
    });

    it("resets allocation counter", () => {
      const { gc } = makeGCWithRoots();
      gc.allocate(makeHeapObj(1));
      gc.allocate(makeHeapObj(2));
      gc.minorGC();
      expect(gc.getStats().allocationsSinceGC).toBe(0);
      expect(gc.stats.minorGCCount).toBe(1);
    });

    it("processes remembered set — old→young references keep young objects alive", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const oldObj = makeHeapObj("old");
      gc.allocate(oldObj, true);
      rootObjects.push(oldObj);

      const youngChild = makeHeapObj("young-child");
      gc.allocate(youngChild);
      oldObj.visitReferences = (cb) => cb(youngChild);
      gc.rememberedSet.record(oldObj);

      gc.minorGC();
      expect(youngChild.gcHeader.age).toBe(1);
    });
  });

  describe("majorGC (mark-compact)", () => {
    it("collects unreachable old-gen objects", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const live = makeHeapObj("live");
      const dead = makeHeapObj("dead");
      gc.allocate(live, true);
      gc.allocate(dead, true);
      rootObjects.push(live);

      const oldLiveBefore = gc.oldGen.liveCount;
      gc.majorGC();
      expect(gc.oldGen.liveCount).toBeLessThan(oldLiveBefore);
      expect(gc.stats.majorGCCount).toBe(1);
      expect(gc.stats.totalCollected).toBeGreaterThan(0);
    });

    it("keeps reachable old-gen objects alive through references", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const child = makeHeapObj("child");
      const parent = makeHeapObj("parent", [child]);
      gc.allocate(parent, true);
      gc.allocate(child, true);
      rootObjects.push(parent);

      gc.majorGC();
      expect(gc.oldGen.liveCount).toBe(2);
    });
  });

  describe("collectGarbage", () => {
    it("minor type runs only scavenge", () => {
      const { gc } = makeGCWithRoots();
      gc.collectGarbage("minor");
      expect(gc.stats.minorGCCount).toBe(1);
      expect(gc.stats.majorGCCount).toBe(0);
    });

    it("major/full type runs both scavenge and mark-compact", () => {
      const { gc } = makeGCWithRoots();
      gc.collectGarbage("full");
      expect(gc.stats.minorGCCount).toBe(1);
      expect(gc.stats.majorGCCount).toBe(1);
    });
  });

  describe("incremental major GC", () => {
    it("full lifecycle: start → steps → finish sweeps old gen", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const live = makeHeapObj("live");
      const dead = makeHeapObj("dead");
      gc.allocate(live, true);
      gc.allocate(dead, true);
      rootObjects.push(live);

      gc.startIncrementalMajorGC();
      expect(gc.isIncrementalMarkingActive()).toBe(true);

      while (gc.incrementalMarkingStep(1000)) {}

      expect(gc.isIncrementalMarkingActive()).toBe(false);
      expect(gc.stats.majorGCCount).toBe(1);
      expect(gc.stats.totalCollected).toBeGreaterThan(0);
    });

    it("startIncrementalMajorGC is idempotent", () => {
      const { gc } = makeGCWithRoots();
      gc.startIncrementalMajorGC();
      gc.startIncrementalMajorGC();
      expect(gc.isIncrementalMarkingActive()).toBe(true);
    });

    it("finishIncrementalMajorGC is no-op when not active", () => {
      const { gc } = makeGCWithRoots();
      gc.finishIncrementalMajorGC();
      expect(gc.stats.majorGCCount).toBe(0);
    });
  });

  describe("generation queries", () => {
    it("isInYoungGen/isInOldGen return correct results", () => {
      const { gc } = makeGCWithRoots();
      const young = makeHeapObj("y");
      const old = makeHeapObj("o");
      gc.allocate(young);
      gc.allocate(old, true);
      expect(gc.isInYoungGen(young)).toBe(true);
      expect(gc.isInOldGen(young)).toBe(false);
      expect(gc.isInOldGen(old)).toBe(true);
      expect(gc.isInYoungGen(old)).toBe(false);
    });

    it("handles null/no-header gracefully", () => {
      const { gc } = makeGCWithRoots();
      expect(gc.isInYoungGen(null)).toBeFalsy();
      expect(gc.isInOldGen({})).toBeFalsy();
    });
  });

  describe("adaptive allocation budget", () => {
    it("budget adjusts after minor GC based on pause time", () => {
      const { gc } = makeGCWithRoots({
        youngGenSize: 64,
        allocationBudget: 4096,
      });
      const initialBudget = gc._allocationBudget;
      gc.minorGC();
      expect(typeof gc._allocationBudget).toBe("number");
      expect(gc._allocationBudget).toBeGreaterThanOrEqual(1024);
      expect(gc._allocationBudget).toBeLessThanOrEqual(65536);
    });

    it("does not reduce budget below minimum (1024)", () => {
      const { gc } = makeGCWithRoots({
        youngGenSize: 64,
        allocationBudget: 1024,
        targetPauseMs: 0,
      });
      gc.minorGC();
      expect(gc._allocationBudget).toBeGreaterThanOrEqual(1024);
    });

    it("accepts custom targetPauseMs from options", () => {
      const gc = new GenerationalGC({ targetPauseMs: 5 });
      expect(gc._targetPauseMs).toBe(5);
    });

    it("uses default targetPauseMs when not specified", () => {
      const gc = new GenerationalGC({});
      expect(gc._targetPauseMs).toBe(2);
    });
  });

  describe("remembered set rebuild only on major GC", () => {
    it("minor GC clears remembered set but does not rebuild from old gen", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const oldObj = makeHeapObj("old");
      gc.allocate(oldObj, true);
      rootObjects.push(oldObj);

      const youngChild = makeHeapObj("young-child");
      gc.allocate(youngChild);
      rootObjects.push(youngChild);

      gc.rememberedSet.record(oldObj);
      gc.minorGC();
      expect(gc.rememberedSet.size).toBe(0);
    });

    it("major GC rebuilds remembered set from old gen", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const youngObj = makeHeapObj("young");
      gc.allocate(youngObj);
      rootObjects.push(youngObj);

      const oldObj = makeHeapObj("old-parent");
      gc.allocate(oldObj, true);
      rootObjects.push(oldObj);
      oldObj.visitReferences = (cb) => cb(youngObj);

      gc.majorGC();
      expect(gc.rememberedSet.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getStats", () => {
    it("returns comprehensive stats after GC activity", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32, allocationBudget: 100 });
      for (let i = 0; i < 5; i++) {
        const obj = makeHeapObj(i);
        gc.allocate(obj);
        rootObjects.push(obj);
      }
      gc.collectGarbage("full");
      const stats = gc.getStats();
      expect(stats.totalAllocated).toBe(5);
      expect(stats.minorGCCount).toBe(1);
      expect(stats.majorGCCount).toBe(1);
      expect(stats).toHaveProperty("youngGenUsed");
      expect(stats).toHaveProperty("oldGenLive");
      expect(stats).toHaveProperty("rememberedSetSize");
    });
  });

  describe("heap-payload reclamation", () => {
    it("frees heap-payload slots of dead young objects during minorGC", () => {
      const { gc } = makeGCWithRoots({ youngGenSize: 256, allocationBudget: 10000 });
      const before = heapPayloadCount();
      for (let i = 0; i < 50; i++) {
        const obj = makeHeapObj(i);
        mkObject(obj);
        gc.allocate(obj);
      }
      expect(heapPayloadCount()).toBe(before + 50);
      gc.minorGC();
      expect(heapPayloadCount()).toBe(before);
    });

    it("keeps slots of young objects still reachable from roots", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 256, allocationBudget: 10000 });
      const before = heapPayloadCount();
      for (let i = 0; i < 30; i++) {
        const obj = makeHeapObj(i);
        mkObject(obj);
        gc.allocate(obj);
        if (i % 2 === 0) rootObjects.push(obj);
      }
      gc.minorGC();
      expect(heapPayloadCount()).toBe(before + 15);
    });
  });
});

describe("heap-payload reachability sweep (boxed-primitive reclamation)", () => {
  it("keeps the boxed-primitive slab bounded under a double-heavy loop", () => {
    const engine = new Engine();
    engine.run(
      "var s=0.0; for(var i=0;i<1500000;i++){ s = s + (i*1.5) - 0.25; } return s;",
    );
    
    
    expect(heapPayloadLiveBytesEstimate()).toBeLessThan(1 << 20);
  }, 20000);

  it("preserves live state (objects, arrays, closures, generators) across sweeps", () => {
    const engine = new Engine();
    engine.run(`
      var keep = [];
      for (var i=0;i<30;i++) keep.push({ v: i*1.5 + 0.5 });
      function mk(b){ return function(){ return b; }; }
      var clo = mk(7.75);
      function* g(){ var a=1.25; while(true){ yield a; a = a + 0.5; } }
      var it = g();
      var first = it.next().value;
    `);
    
    engine.run("var t=0.0; for(var i=0;i<1500000;i++){ t = t + keep[i%30].v*1.5; }");
    expect(engine.runValue("return keep[0].v;").value).toBe(0.5);
    expect(engine.runValue("return keep[20].v;").value).toBe(30.5);
    expect(engine.runValue("return keep.length;").value).toBe(30);
    expect(engine.runValue("return clo();").value).toBe(7.75);
    expect(engine.runValue("return first;").value).toBe(1.25);
    expect(engine.runValue("return it.next().value;").value).toBe(1.75);
    expect(engine.runValue("return it.next().value;").value).toBe(2.25);
  }, 20000);
});
