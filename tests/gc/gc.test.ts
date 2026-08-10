import { describe, it, expect } from "vitest";
import { GenerationalGC } from "../../src/gc/gc.js";
import { COLOR_WHITE } from "../../src/gc/incremental-marker.js";
import { mkObject, heapPayloadCount } from "../../src/core/value/index.js";

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
      const inYoung = objs.filter((o) => o.gcHeader.generation === "young");
      expect(inYoung.length).toBeLessThanOrEqual(2);
      expect(inOld.length).toBe(objs.length - inYoung.length);
      expect(inOld.length).toBe(3);
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

      expect(youngObj.gcHeader.generation).toBe("young");
      expect(gc.rememberedSet.has(oldObj)).toBe(true);
      expect(gc.rememberedSet.size).toBe(1);
    });

    it("major GC leaves an old object with no young reference out of the rebuilt set", () => {
      const { gc, rootObjects } = makeGCWithRoots({ youngGenSize: 32 });
      const oldChild = makeHeapObj("old-child");
      gc.allocate(oldChild, true);
      rootObjects.push(oldChild);

      const oldParent = makeHeapObj("old-parent");
      gc.allocate(oldParent, true);
      rootObjects.push(oldParent);
      oldParent.visitReferences = (cb) => cb(oldChild);

      gc.rememberedSet.record(oldParent);
      gc.majorGC();

      expect(gc.rememberedSet.has(oldParent)).toBe(false);
      expect(gc.rememberedSet.size).toBe(0);
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
      expect(stats.youngGenUsed).toBe(gc.fromSpace.usedSlots());
      expect(stats.oldGenLive).toBe(gc.oldGen.liveCount);
      expect(stats.rememberedSetSize).toBe(gc.rememberedSet.size);
      expect(stats.oldGenLive + stats.youngGenUsed).toBe(5);
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
