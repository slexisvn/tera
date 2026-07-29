import { describe, it, expect } from "vitest";
import { HeapRegion } from "../../src/gc/heap-region.js";

function makeObj(id) {
  return { id };
}

describe("HeapRegion", () => {
  it("allocate returns sequential indices and get retrieves them", () => {
    const region = new HeapRegion(4);
    const a = makeObj("a");
    const b = makeObj("b");
    expect(region.allocate(a)).toBe(0);
    expect(region.allocate(b)).toBe(1);
    expect(region.get(0)).toBe(a);
    expect(region.get(1)).toBe(b);
    expect(region.usedSlots()).toBe(2);
  });

  it("returns null when full", () => {
    const region = new HeapRegion(2);
    region.allocate(makeObj(1));
    region.allocate(makeObj(2));
    expect(region.allocate(makeObj(3))).toBeNull();
    expect(region.isFull()).toBe(true);
  });

  it("reset clears all slots and allows reallocation from 0", () => {
    const region = new HeapRegion(4);
    region.allocate(makeObj(1));
    region.allocate(makeObj(2));
    region.reset();
    expect(region.usedSlots()).toBe(0);
    expect(region.isFull()).toBe(false);
    expect(region.get(0)).toBeUndefined();
    expect(region.allocate(makeObj(3))).toBe(0);
  });

  it("set overwrites a slot", () => {
    const region = new HeapRegion(4);
    const a = makeObj("a");
    const b = makeObj("b");
    region.allocate(a);
    region.set(0, b);
    expect(region.get(0)).toBe(b);
  });

  it("reset clears stale slots left above a shrunken allocPointer", () => {
    const region = new HeapRegion(8);
    const survivors = [makeObj("s0"), makeObj("s1")];
    for (let i = 0; i < 6; i++) region.allocate(makeObj(`dead${i}`));
    region.reset();
    region.allocate(survivors[0]);
    region.allocate(survivors[1]);
    region.reset();
    for (let i = 0; i < region.size; i++) {
      expect(region.get(i)).toBeUndefined();
    }
  });

  it("forEach visits only allocated non-undefined slots", () => {
    const region = new HeapRegion(8);
    region.allocate(makeObj("a"));
    region.allocate(makeObj("b"));
    region.set(0, undefined);
    const visited = [];
    region.forEach((obj, i) => visited.push({ obj, i }));
    expect(visited).toHaveLength(1);
    expect(visited[0].i).toBe(1);
    expect(visited[0].obj.id).toBe("b");
  });
});
