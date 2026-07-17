import { describe, it, expect } from "vitest";
import { OldGeneration, FreeList } from "../../src/gc/old-generation.js";

function makeOldObj(id) {
  return {
    id,
    gcHeader: { age: 2, marked: false, forwarding: null, generation: "old", youngIndex: -1, oldGenIndex: -1, color: 0 },
  };
}

describe("FreeList", () => {
  it("take returns null on empty, LIFO order otherwise", () => {
    const fl = new FreeList();
    expect(fl.take()).toBeNull();
    fl.add(5);
    fl.add(3);
    expect(fl.take()).toBe(3);
    expect(fl.take()).toBe(5);
    expect(fl.totalFree).toBe(0);
  });

  it("clear empties all slots", () => {
    const fl = new FreeList();
    fl.add(1);
    fl.add(2);
    fl.clear();
    expect(fl.totalFree).toBe(0);
    expect(fl.take()).toBeNull();
  });
});

describe("OldGeneration", () => {
  it("allocate assigns sequential indices and updates liveCount", () => {
    const old = new OldGeneration(16);
    const a = makeOldObj("a");
    const b = makeOldObj("b");
    const i1 = old.allocate(a);
    const i2 = old.allocate(b);
    expect(i1).toBe(0);
    expect(i2).toBe(1);
    expect(a.gcHeader.oldGenIndex).toBe(0);
    expect(old.liveCount).toBe(2);
  });

  it("allocate reuses free list slots before bumping pointer", () => {
    const old = new OldGeneration(16);
    const a = makeOldObj("a");
    const b = makeOldObj("b");
    old.allocate(a);
    old.allocate(b);
    old.storage[0] = undefined;
    old.liveCount--;
    old.freeList.add(0);

    const c = makeOldObj("c");
    const idx = old.allocate(c);
    expect(idx).toBe(0);
    expect(old.storage[0]).toBe(c);
  });

  it("grows capacity when full", () => {
    const old = new OldGeneration(2);
    old.allocate(makeOldObj(1));
    old.allocate(makeOldObj(2));
    const initialCap = old.capacity;
    old.allocate(makeOldObj(3));
    expect(old.capacity).toBe(initialCap * 2);
    expect(old.liveCount).toBe(3);
  });

  describe("markCompact", () => {
    it("sweeps unmarked objects and returns sweep count", () => {
      const old = new OldGeneration(16);
      const live = makeOldObj("live");
      const dead = makeOldObj("dead");
      old.allocate(live);
      old.allocate(dead);

      const markSet = new Set([live]);
      const { swept } = old.markCompact(markSet);
      expect(swept).toBe(1);
      expect(old.liveCount).toBe(1);
      expect(old.storage[1]).toBeUndefined();
    });

    it("evacuates objects from sparse pages to denser locations", () => {
      const PAGE_SIZE = 1024;
      const old = new OldGeneration(PAGE_SIZE * 4);
      const objects = [];
      for (let i = 0; i < PAGE_SIZE; i++) {
        const obj = makeOldObj(i);
        old.allocate(obj);
        objects.push(obj);
      }

      const markSet = new Set();
      const survivorCount = Math.floor(PAGE_SIZE * 0.3);
      for (let i = 0; i < survivorCount; i++) {
        markSet.add(objects[i]);
      }

      const { swept, evacuated } = old.markCompact(markSet);
      expect(swept).toBe(PAGE_SIZE - survivorCount);
      expect(evacuated).toBeGreaterThan(0);

      for (const obj of markSet) {
        expect(old.storage[obj.gcHeader.oldGenIndex]).toBe(obj);
      }
    });

    it("rebuilds free list after sweep", () => {
      const old = new OldGeneration(16);
      for (let i = 0; i < 5; i++) old.allocate(makeOldObj(i));
      const markSet = new Set([old.storage[0], old.storage[2], old.storage[4]]);
      old.markCompact(markSet);
      expect(old.freeList.totalFree).toBeGreaterThan(0);
    });
  });

  describe("compact", () => {
    it("defragments when fragmentation exceeds 30%", () => {
      const old = new OldGeneration(16);
      for (let i = 0; i < 10; i++) old.allocate(makeOldObj(i));
      for (let i = 0; i < 5; i++) {
        old.storage[i * 2] = undefined;
        old.freeList.add(i * 2);
      }
      old.liveCount = 5;

      const compacted = old.compact();
      expect(compacted).toBe(5);
      expect(old.allocPointer).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(old.storage[i]).toBeDefined();
        expect(old.storage[i].gcHeader.oldGenIndex).toBe(i);
      }
    });

    it("skips compaction when fragmentation is low", () => {
      const old = new OldGeneration(16);
      for (let i = 0; i < 10; i++) old.allocate(makeOldObj(i));
      expect(old.compact()).toBe(0);
    });
  });

  it("growthRate tracks change between GC cycles", () => {
    const old = new OldGeneration(64);
    for (let i = 0; i < 10; i++) old.allocate(makeOldObj(i));
    old.markCompact(new Set(Array.from({ length: 10 }, (_, i) => old.storage[i])));
    for (let i = 0; i < 5; i++) old.allocate(makeOldObj(100 + i));
    expect(old.growthRate()).toBeCloseTo(0.5);
  });

  it("forEach visits all live objects", () => {
    const old = new OldGeneration(16);
    old.allocate(makeOldObj("a"));
    old.allocate(makeOldObj("b"));
    old.storage[0] = undefined;
    const visited = [];
    old.forEach((obj) => visited.push(obj.id));
    expect(visited).toEqual(["b"]);
  });
});
