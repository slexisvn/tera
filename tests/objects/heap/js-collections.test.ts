import { describe, it, expect } from "vitest";
import {
  OrderedHashMap,
  OrderedHashSet,
  EphemeronHashTable,
} from "../../../src/objects/heap/js-collections.js";
import { mkSmi, mkDouble, mkString, mkNull, mkUndefined, mkObject, mkBool } from "../../../src/core/value/index.js";

describe("OrderedHashMap", () => {
  it("set/get round-trips for smi keys", () => {
    const map = new OrderedHashMap();
    const k = mkSmi(42);
    const v = mkString("val");
    map.set(k, v);
    expect(map.get(k)).toBe(v);
    expect(map.size).toBe(1);
  });

  it("set/get round-trips for string keys", () => {
    const map = new OrderedHashMap();
    const k = mkString("hello");
    map.set(k, mkSmi(99));
    expect(map.get(k)).toBe(mkSmi(99));
  });

  it("overwrite updates value without changing size", () => {
    const map = new OrderedHashMap();
    const k = mkSmi(1);
    map.set(k, mkSmi(10));
    map.set(k, mkSmi(20));
    expect(map.get(k)).toBe(mkSmi(20));
    expect(map.size).toBe(1);
  });

  it("has returns false for missing key", () => {
    const map = new OrderedHashMap();
    expect(map.has(mkSmi(999))).toBe(false);
  });

  it("delete removes entry and decrements size", () => {
    const map = new OrderedHashMap();
    const k = mkSmi(1);
    map.set(k, mkSmi(10));
    expect(map.delete(k)).toBe(true);
    expect(map.has(k)).toBe(false);
    expect(map.size).toBe(0);
  });

  it("delete returns false for missing key", () => {
    const map = new OrderedHashMap();
    expect(map.delete(mkSmi(999))).toBe(false);
  });

  it("clear resets everything", () => {
    const map = new OrderedHashMap();
    map.set(mkSmi(1), mkSmi(10));
    map.set(mkSmi(2), mkSmi(20));
    map.clear();
    expect(map.size).toBe(0);
    expect(map.has(mkSmi(1))).toBe(false);
  });

  it("iterateEntries preserves insertion order", () => {
    const map = new OrderedHashMap();
    const keys = [mkSmi(3), mkSmi(1), mkSmi(2)];
    keys.forEach((k, i) => map.set(k, mkSmi(i)));
    const result = [...map.iterateEntries()].map(([k]) => k);
    expect(result).toEqual(keys);
  });

  it("iterateEntries skips deleted entries", () => {
    const map = new OrderedHashMap();
    map.set(mkSmi(1), mkSmi(10));
    map.set(mkSmi(2), mkSmi(20));
    map.set(mkSmi(3), mkSmi(30));
    map.delete(mkSmi(2));
    const keys = [...map.iterateKeys()];
    expect(keys).toEqual([mkSmi(1), mkSmi(3)]);
  });

  it("rehashes under load without losing data", () => {
    const map = new OrderedHashMap();
    for (let i = 0; i < 20; i++) {
      map.set(mkSmi(i), mkSmi(i * 10));
    }
    expect(map.size).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(map.get(mkSmi(i))).toBe(mkSmi(i * 10));
    }
  });

  it("handles null and undefined as keys", () => {
    const map = new OrderedHashMap();
    map.set(mkNull(), mkSmi(1));
    map.set(mkUndefined(), mkSmi(2));
    expect(map.get(mkNull())).toBe(mkSmi(1));
    expect(map.get(mkUndefined())).toBe(mkSmi(2));
    expect(map.size).toBe(2);
  });

  it("handles bool keys", () => {
    const map = new OrderedHashMap();
    map.set(mkBool(true), mkSmi(1));
    map.set(mkBool(false), mkSmi(0));
    expect(map.get(mkBool(true))).toBe(mkSmi(1));
    expect(map.get(mkBool(false))).toBe(mkSmi(0));
  });

  it("NaN key is found via SameValueZero", () => {
    const map = new OrderedHashMap();
    map.set(mkDouble(NaN), mkSmi(42));
    expect(map.has(mkDouble(NaN))).toBe(true);
    expect(map.get(mkDouble(NaN))).toBe(mkSmi(42));
  });

  it("+0 and -0 are the same key (SameValueZero)", () => {
    const map = new OrderedHashMap();
    map.set(mkDouble(-0), mkSmi(7));
    expect(map.get(mkSmi(0))).toBe(mkSmi(7));
    map.set(mkSmi(0), mkSmi(9));
    expect(map.size).toBe(1);
    expect(map.get(mkDouble(-0))).toBe(mkSmi(9));
  });
});

describe("OrderedHashSet", () => {
  it("add/has basic operations", () => {
    const set = new OrderedHashSet();
    set.add(mkSmi(1));
    set.add(mkSmi(2));
    expect(set.has(mkSmi(1))).toBe(true);
    expect(set.has(mkSmi(3))).toBe(false);
    expect(set.size).toBe(2);
  });

  it("add is idempotent", () => {
    const set = new OrderedHashSet();
    set.add(mkSmi(1));
    set.add(mkSmi(1));
    expect(set.size).toBe(1);
  });

  it("delete works", () => {
    const set = new OrderedHashSet();
    set.add(mkSmi(1));
    expect(set.delete(mkSmi(1))).toBe(true);
    expect(set.has(mkSmi(1))).toBe(false);
    expect(set.size).toBe(0);
  });

  it("iterateValues preserves insertion order", () => {
    const set = new OrderedHashSet();
    const vals = [mkSmi(5), mkSmi(3), mkSmi(7)];
    vals.forEach((v) => set.add(v));
    expect([...set.iterateValues()]).toEqual(vals);
  });

  it("rehashes under load without losing data", () => {
    const set = new OrderedHashSet();
    for (let i = 0; i < 20; i++) set.add(mkSmi(i));
    expect(set.size).toBe(20);
    for (let i = 0; i < 20; i++) expect(set.has(mkSmi(i))).toBe(true);
  });

  it("iterateEntries yields [value, value] pairs", () => {
    const set = new OrderedHashSet();
    set.add(mkSmi(42));
    const entries = [...set.iterateEntries()];
    expect(entries).toEqual([[mkSmi(42), mkSmi(42)]]);
  });
});

describe("EphemeronHashTable", () => {
  function makeObjKey() {
    return mkObject({ gcHeader: { heapId: Math.floor(Math.random() * 10000) + 1 } });
  }

  it("set/get round-trips for object keys", () => {
    const table = new EphemeronHashTable();
    const k = makeObjKey();
    table.set(k, mkSmi(99));
    expect(table.get(k)).toBe(mkSmi(99));
    expect(table.size).toBe(1);
  });

  it("rejects non-object keys", () => {
    const table = new EphemeronHashTable();
    expect(() => table.set(mkSmi(1), mkSmi(1))).toThrow("Invalid value");
  });

  it("get returns undefined for non-object keys", () => {
    const table = new EphemeronHashTable();
    expect(table.get(mkSmi(1))).toBeUndefined();
  });

  it("has returns false for non-object keys", () => {
    const table = new EphemeronHashTable();
    expect(table.has(mkString("nope"))).toBe(false);
  });

  it("delete works", () => {
    const table = new EphemeronHashTable();
    const k = makeObjKey();
    table.set(k, mkSmi(1));
    expect(table.delete(k)).toBe(true);
    expect(table.has(k)).toBe(false);
    expect(table.size).toBe(0);
  });

  it("delete returns false for missing key", () => {
    const table = new EphemeronHashTable();
    expect(table.delete(makeObjKey())).toBe(false);
  });

  it("overwrite updates value", () => {
    const table = new EphemeronHashTable();
    const k = makeObjKey();
    table.set(k, mkSmi(1));
    table.set(k, mkSmi(2));
    expect(table.get(k)).toBe(mkSmi(2));
    expect(table.size).toBe(1);
  });

  it("rehashes under load", () => {
    const table = new EphemeronHashTable();
    const keys = [];
    for (let i = 0; i < 20; i++) {
      const k = makeObjKey();
      keys.push(k);
      table.set(k, mkSmi(i));
    }
    expect(table.size).toBe(20);
    keys.forEach((k, i) => expect(table.get(k)).toBe(mkSmi(i)));
  });
});
