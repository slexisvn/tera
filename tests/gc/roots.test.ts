import { describe, it, expect } from "vitest";
import { enumerateRoots, extractHeapObject } from "../../src/gc/roots.js";

function makeGCObj(id) {
  return {
    id,
    gcHeader: { generation: "young", color: 0 },
  };
}

describe("extractHeapObject", () => {
  it("returns object with gcHeader directly", () => {
    const obj = makeGCObj("a");
    expect(extractHeapObject(obj)).toBe(obj);
  });

  it("returns null for primitives and non-gc objects", () => {
    expect(extractHeapObject(null)).toBeNull();
    expect(extractHeapObject(undefined)).toBeNull();
    expect(extractHeapObject(42)).toBeNull();
    expect(extractHeapObject("str")).toBeNull();
    expect(extractHeapObject({})).toBeNull();
  });
});

describe("enumerateRoots", () => {
  it("collects gc objects from interpreter frame locals and stack", () => {
    const local1 = makeGCObj("local1");
    const stack1 = makeGCObj("stack1");
    const interpreter = {
      activeFrames: [
        { locals: [local1, 42, null], stack: [stack1, "notgc"] },
      ],
    };
    const roots = enumerateRoots(interpreter, null, null);
    expect(roots).toContain(local1);
    expect(roots).toContain(stack1);
    expect(roots).toHaveLength(2);
  });

  it("collects gc objects from globalCells Map", () => {
    const obj = makeGCObj("global");
    const globalCells = new Map();
    globalCells.set("x", { value: obj });
    const roots = enumerateRoots(null, globalCells, null);
    expect(roots).toContain(obj);
  });

  it("collects promises from microtask queue", () => {
    const promise = makeGCObj("promise");
    const queue = {
      queue: [{ promise }],
    };
    const roots = enumerateRoots(null, null, queue);
    expect(roots).toContain(promise);
  });

  it("handles all null inputs gracefully", () => {
    expect(enumerateRoots(null, null, null)).toEqual([]);
  });

  it("collects from multiple frames", () => {
    const a = makeGCObj("a");
    const b = makeGCObj("b");
    const interpreter = {
      activeFrames: [
        { locals: [a], stack: [] },
        { locals: [], stack: [b] },
      ],
    };
    const roots = enumerateRoots(interpreter, null, null);
    expect(roots).toContain(a);
    expect(roots).toContain(b);
  });
});
