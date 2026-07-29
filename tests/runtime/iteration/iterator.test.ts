import { describe, it, expect } from "vitest";
import {
  IteratorRecord,
  createIteratorResult,
  getIterator,
  iteratorDone,
  iteratorValue,
} from "../../../src/runtime/iteration/iterator.js";
import {
  mkSmi,
  mkString,
  mkArray,
  mkBool,
  mkUndefined,
  mkObject,
  isObject,
  getPayload,
} from "../../../src/core/value/index.js";
import { createJSArray } from "../../../src/objects/heap/factory.js";

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

describe("createIteratorResult", () => {
  it("produces object with value and done fields", () => {
    const result = createIteratorResult(mkSmi(42), false);
    expect(isObject(result)).toBe(true);
    expect(iteratorValue(result)).toBe(mkSmi(42));
    expect(iteratorDone(result)).toBe(false);
  });

  it("done=true signals completion", () => {
    const result = createIteratorResult(mkUndefined(), true);
    expect(iteratorDone(result)).toBe(true);
  });
});

describe("iteratorDone", () => {
  it("returns true for non-object values", () => {
    expect(iteratorDone(mkSmi(1))).toBe(true);
    expect(iteratorDone(mkString("x"))).toBe(true);
  });
});

describe("iteratorValue", () => {
  it("returns undefined for non-object values", () => {
    expect(iteratorValue(mkSmi(1))).toBe(mkUndefined());
  });
});

describe("getIterator", () => {
  it("iterates array elements in order", () => {
    const arr = mkArray(createJSArray([mkSmi(10), mkSmi(20), mkSmi(30)]));
    const values = collectIterator(getIterator(arr));
    expect(values).toEqual([mkSmi(10), mkSmi(20), mkSmi(30)]);
  });

  it("array iterator handles empty array", () => {
    const arr = mkArray(createJSArray([]));
    const values = collectIterator(getIterator(arr));
    expect(values).toEqual([]);
  });

  it("iterates string characters", () => {
    const str = mkString("abc");
    const values = collectIterator(getIterator(str));
    expect(values.map((v) => getPayload(v))).toEqual(["a", "b", "c"]);
  });

  it("string iterator handles empty string", () => {
    const str = mkString("");
    const values = collectIterator(getIterator(str));
    expect(values).toEqual([]);
  });

  it("throws for non-iterable value", () => {
    expect(() => getIterator(mkSmi(42))).toThrow(/not iterable/);
  });

  it("array iterator yields undefined for holes", () => {
    const jsArr = createJSArray([mkSmi(1), undefined, mkSmi(3)]);
    const arr = mkArray(jsArr);
    const values = collectIterator(getIterator(arr));
    expect(values[0]).toBe(mkSmi(1));
    expect(values[1]).toBe(mkUndefined());
    expect(values[2]).toBe(mkSmi(3));
  });

  it("iterator is single-pass (not restartable)", () => {
    const arr = mkArray(createJSArray([mkSmi(1), mkSmi(2)]));
    const iter = getIterator(arr);
    const record = getPayload(iter);
    record.nextValue(null);
    record.nextValue(null);
    const third = record.nextValue(null);
    expect(iteratorDone(third)).toBe(true);
  });
});

describe("IteratorRecord", () => {
  it("custom next function drives iteration", () => {
    let count = 0;
    const record = new IteratorRecord(() => {
      if (count >= 3) return createIteratorResult(mkUndefined(), true);
      return createIteratorResult(mkSmi(count++), false);
    });
    const results = [];
    for (let i = 0; i < 5; i++) {
      const r = record.nextValue(null);
      if (iteratorDone(r)) break;
      results.push(iteratorValue(r));
    }
    expect(results).toEqual([mkSmi(0), mkSmi(1), mkSmi(2)]);
  });
});
