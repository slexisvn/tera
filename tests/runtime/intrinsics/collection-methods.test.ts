import { describe, it, expect } from "vitest";
import { MAP_METHODS } from "../../../src/runtime/intrinsics/map-methods.js";
import { SET_METHODS } from "../../../src/runtime/intrinsics/set-methods.js";
import { WEAKMAP_METHODS } from "../../../src/runtime/intrinsics/weakmap-methods.js";
import {
  mkSmi,
  mkString,
  mkBool,
  mkUndefined,
  mkObject,
  mkFunction,
  getPayload,
  isArray,
} from "../../../src/core/value/index.js";
import { createJSMap, createJSObject, createJSSet, createJSWeakMap } from "../../../src/objects/heap/factory.js";
import { iteratorDone, iteratorValue } from "../../../src/runtime/iteration/iterator.js";

function makeMap() {
  return mkObject(createJSMap());
}

function makeSet() {
  return mkObject(createJSSet());
}

function makeWeakMap() {
  return mkObject(createJSWeakMap());
}

function mockInterpreter() {
  return {
    callFunctionValue(fn, args, thisVal) {
      return getPayload(fn).call(args, thisVal);
    },
  };
}

function collectIterator(iterVal) {
  const record = getPayload(iterVal);
  const results = [];
  for (let i = 0; i < 100; i++) {
    const result = record.nextValue(null);
    if (iteratorDone(result)) break;
    results.push(iteratorValue(result));
  }
  return results;
}

describe("MAP_METHODS", () => {
  describe("CRUD operations", () => {
    it("set/get/has/delete lifecycle", () => {
      const m = makeMap();
      const key = mkString("x");

      MAP_METHODS.set.call([key, mkSmi(42)], m);
      expect(MAP_METHODS.get.call([key], m)).toBe(mkSmi(42));
      expect(MAP_METHODS.has.call([key], m)).toBe(mkBool(true));
      expect(MAP_METHODS.delete.call([key], m)).toBe(mkBool(true));
      expect(MAP_METHODS.has.call([key], m)).toBe(mkBool(false));
      expect(MAP_METHODS.get.call([key], m)).toBe(mkUndefined());
    });

    it("overwriting a key updates value", () => {
      const m = makeMap();
      const key = mkString("k");
      MAP_METHODS.set.call([key, mkSmi(1)], m);
      MAP_METHODS.set.call([key, mkSmi(2)], m);
      expect(MAP_METHODS.get.call([key], m)).toBe(mkSmi(2));
    });

    it("clear removes all entries", () => {
      const m = makeMap();
      MAP_METHODS.set.call([mkSmi(1), mkSmi(10)], m);
      MAP_METHODS.set.call([mkSmi(2), mkSmi(20)], m);
      MAP_METHODS.clear.call([], m);
      expect(MAP_METHODS.has.call([mkSmi(1)], m)).toBe(mkBool(false));
      expect(MAP_METHODS.has.call([mkSmi(2)], m)).toBe(mkBool(false));
    });

    it("set returns the map for chaining", () => {
      const m = makeMap();
      expect(MAP_METHODS.set.call([mkSmi(1), mkSmi(2)], m)).toBe(m);
    });

    it("delete returns false for non-existent key", () => {
      const m = makeMap();
      expect(MAP_METHODS.delete.call([mkSmi(999)], m)).toBe(mkBool(false));
    });
  });

  describe("forEach", () => {
    it("iterates all entries with value, key, map args", () => {
      const interp = mockInterpreter();
      const m = makeMap();
      MAP_METHODS.set.call([mkString("a"), mkSmi(1)], m);
      MAP_METHODS.set.call([mkString("b"), mkSmi(2)], m);
      const collected = [];
      const cb = mkFunction({
        name: "cb",
        call: (args) => {
          collected.push([args[1], args[0]]);
          return mkUndefined();
        },
      });
      MAP_METHODS.forEach.call([cb], m, interp);
      expect(collected).toHaveLength(2);
    });

    it("throws on non-function callback", () => {
      const m = makeMap();
      expect(() => MAP_METHODS.forEach.call([mkSmi(1)], m, mockInterpreter())).toThrow(/not a function/);
    });
  });

  describe("iterators", () => {
    it("entries yields [key, value] pairs in insertion order", () => {
      const m = makeMap();
      MAP_METHODS.set.call([mkString("a"), mkSmi(1)], m);
      MAP_METHODS.set.call([mkString("b"), mkSmi(2)], m);
      const entries = collectIterator(MAP_METHODS.entries.call([], m));
      expect(entries).toHaveLength(2);
      const first = getPayload(entries[0]);
      expect(getPayload(first.getIndex(0))).toBe("a");
      expect(first.getIndex(1)).toBe(mkSmi(1));
    });

    it("keys and values yield correct sequences", () => {
      const m = makeMap();
      MAP_METHODS.set.call([mkSmi(10), mkString("x")], m);
      MAP_METHODS.set.call([mkSmi(20), mkString("y")], m);
      const keys = collectIterator(MAP_METHODS.keys.call([], m));
      expect(keys).toEqual([mkSmi(10), mkSmi(20)]);
      const values = collectIterator(MAP_METHODS.values.call([], m));
      expect(values.map(v => getPayload(v))).toEqual(["x", "y"]);
    });
  });

  it("throws on non-Map receiver", () => {
    const fakeObj = mkObject(getPayload(mkObject(createJSObject())));
    expect(() => MAP_METHODS.get.call([mkSmi(1)], fakeObj)).toThrow(/incompatible receiver/);
  });
});

describe("SET_METHODS", () => {
  describe("CRUD operations", () => {
    it("add/has/delete lifecycle", () => {
      const s = makeSet();
      const val = mkSmi(42);
      SET_METHODS.add.call([val], s);
      expect(SET_METHODS.has.call([val], s)).toBe(mkBool(true));
      expect(SET_METHODS.delete.call([val], s)).toBe(mkBool(true));
      expect(SET_METHODS.has.call([val], s)).toBe(mkBool(false));
    });

    it("add is idempotent for same value", () => {
      const s = makeSet();
      SET_METHODS.add.call([mkSmi(1)], s);
      SET_METHODS.add.call([mkSmi(1)], s);
      const values = collectIterator(SET_METHODS.values.call([], s));
      expect(values).toHaveLength(1);
    });

    it("clear removes all values", () => {
      const s = makeSet();
      SET_METHODS.add.call([mkSmi(1)], s);
      SET_METHODS.add.call([mkSmi(2)], s);
      SET_METHODS.clear.call([], s);
      expect(SET_METHODS.has.call([mkSmi(1)], s)).toBe(mkBool(false));
    });

    it("add returns the set for chaining", () => {
      const s = makeSet();
      expect(SET_METHODS.add.call([mkSmi(1)], s)).toBe(s);
    });

    it("delete returns false for non-existent value", () => {
      const s = makeSet();
      expect(SET_METHODS.delete.call([mkSmi(999)], s)).toBe(mkBool(false));
    });
  });

  describe("forEach", () => {
    it("iterates values with value, value, set args", () => {
      const interp = mockInterpreter();
      const s = makeSet();
      SET_METHODS.add.call([mkSmi(10)], s);
      SET_METHODS.add.call([mkSmi(20)], s);
      const collected = [];
      const cb = mkFunction({
        name: "cb",
        call: (args) => {
          collected.push(args[0]);
          return mkUndefined();
        },
      });
      SET_METHODS.forEach.call([cb], s, interp);
      expect(collected).toEqual([mkSmi(10), mkSmi(20)]);
    });
  });

  describe("iterators", () => {
    it("values and keys yield same sequence (Set spec)", () => {
      const s = makeSet();
      SET_METHODS.add.call([mkSmi(1)], s);
      SET_METHODS.add.call([mkSmi(2)], s);
      const keys = collectIterator(SET_METHODS.keys.call([], s));
      const values = collectIterator(SET_METHODS.values.call([], s));
      expect(keys).toEqual(values);
    });

    it("entries yields [value, value] pairs", () => {
      const s = makeSet();
      SET_METHODS.add.call([mkSmi(5)], s);
      const entries = collectIterator(SET_METHODS.entries.call([], s));
      const pair = getPayload(entries[0]);
      expect(pair.getIndex(0)).toBe(mkSmi(5));
      expect(pair.getIndex(1)).toBe(mkSmi(5));
    });
  });
});

describe("WEAKMAP_METHODS", () => {
  it("set/get/has/delete lifecycle with object keys", () => {
    const wm = makeWeakMap();
    const key = mkObject(createJSObject());
    WEAKMAP_METHODS.set.call([key, mkSmi(99)], wm);
    expect(WEAKMAP_METHODS.get.call([key], wm)).toBe(mkSmi(99));
    expect(WEAKMAP_METHODS.has.call([key], wm)).toBe(mkBool(true));
    expect(WEAKMAP_METHODS.delete.call([key], wm)).toBe(mkBool(true));
    expect(WEAKMAP_METHODS.has.call([key], wm)).toBe(mkBool(false));
  });

  it("throws TypeError on non-object key", () => {
    const wm = makeWeakMap();
    expect(() => WEAKMAP_METHODS.set.call([mkSmi(1), mkSmi(2)], wm)).toThrow(/Invalid value/);
  });

  it("different object keys are independent", () => {
    const wm = makeWeakMap();
    const k1 = mkObject(createJSObject());
    const k2 = mkObject(createJSObject());
    WEAKMAP_METHODS.set.call([k1, mkSmi(1)], wm);
    WEAKMAP_METHODS.set.call([k2, mkSmi(2)], wm);
    expect(WEAKMAP_METHODS.get.call([k1], wm)).toBe(mkSmi(1));
    expect(WEAKMAP_METHODS.get.call([k2], wm)).toBe(mkSmi(2));
  });

  it("get returns undefined for missing key", () => {
    const wm = makeWeakMap();
    const key = mkObject(createJSObject());
    expect(WEAKMAP_METHODS.get.call([key], wm)).toBe(mkUndefined());
  });
});
