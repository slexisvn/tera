import { describe, it, expect } from "vitest";
import { ARRAY_METHODS } from "../../../src/runtime/intrinsics/array-methods.js";
import {
  mkSmi,
  mkString,
  mkBool,
  mkUndefined,
  mkArray,
  mkFunction,
  getPayload,
  toNumber,
} from "../../../src/core/value/index.js";
import { createJSArray } from "../../../src/objects/heap/factory.js";

function arr(...vals) {
  return mkArray(createJSArray(vals));
}

function elements(arrVal) {
  const a = getPayload(arrVal);
  const result = [];
  for (let i = 0; i < a.getLength(); i++) {
    result.push(a.getIndex(i));
  }
  return result;
}

function mockInterpreter() {
  return {
    callFunctionValue(fn, args, thisVal) {
      return getPayload(fn).call(args, thisVal);
    },
  };
}

function callMethod(name, thisVal, ...args) {
  return ARRAY_METHODS[name].call(args, thisVal);
}

function callMethodWithInterp(name, thisVal, interp, ...args) {
  return ARRAY_METHODS[name].call(args, thisVal, interp);
}

describe("ARRAY_METHODS", () => {
  describe("push/pop/shift/unshift", () => {
    it("push appends and returns new length", () => {
      const a = arr(mkSmi(1));
      const len = callMethod("push", a, mkSmi(2), mkSmi(3));
      expect(getPayload(len)).toBe(3);
      expect(elements(a).map((v) => getPayload(v))).toEqual([1, 2, 3]);
    });

    it("pop removes last and returns it", () => {
      const a = arr(mkSmi(10), mkSmi(20));
      const val = callMethod("pop", a);
      expect(val).toBe(mkSmi(20));
      expect(getPayload(a).getLength()).toBe(1);
    });

    it("pop on empty returns undefined", () => {
      const a = arr();
      expect(callMethod("pop", a)).toBe(mkUndefined());
    });

    it("shift removes first and returns it", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3));
      const val = callMethod("shift", a);
      expect(val).toBe(mkSmi(1));
      expect(elements(a)).toEqual([mkSmi(2), mkSmi(3)]);
    });

    it("unshift prepends and returns new length", () => {
      const a = arr(mkSmi(3));
      const len = callMethod("unshift", a, mkSmi(1), mkSmi(2));
      expect(getPayload(len)).toBe(3);
      expect(elements(a)).toEqual([mkSmi(1), mkSmi(2), mkSmi(3)]);
    });
  });

  describe("splice", () => {
    it("removes elements and returns removed", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4));
      const removed = callMethod("splice", a, mkSmi(1), mkSmi(2));
      expect(elements(removed)).toEqual([mkSmi(2), mkSmi(3)]);
      expect(elements(a)).toEqual([mkSmi(1), mkSmi(4)]);
    });

    it("inserts elements at position", () => {
      const a = arr(mkSmi(1), mkSmi(4));
      callMethod("splice", a, mkSmi(1), mkSmi(0), mkSmi(2), mkSmi(3));
      expect(elements(a)).toEqual([mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4)]);
    });
  });

  describe("indexOf/lastIndexOf/includes", () => {
    it("indexOf finds element position", () => {
      const a = arr(mkSmi(10), mkSmi(20), mkSmi(30), mkSmi(20));
      expect(callMethod("indexOf", a, mkSmi(20))).toBe(mkSmi(1));
    });

    it("indexOf returns -1 for missing", () => {
      const a = arr(mkSmi(1));
      expect(callMethod("indexOf", a, mkSmi(99))).toBe(mkSmi(-1));
    });

    it("lastIndexOf finds last occurrence", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(1));
      expect(callMethod("lastIndexOf", a, mkSmi(1))).toBe(mkSmi(2));
    });

    it("includes returns bool", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3));
      expect(callMethod("includes", a, mkSmi(2))).toBe(mkBool(true));
      expect(callMethod("includes", a, mkSmi(99))).toBe(mkBool(false));
    });
  });

  describe("concat/slice/join/reverse", () => {
    it("concat merges arrays and scalar values", () => {
      const a = arr(mkSmi(1));
      const b = arr(mkSmi(2), mkSmi(3));
      const result = callMethod("concat", a, b, mkSmi(4));
      expect(elements(result)).toEqual([mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4)]);
    });

    it("slice extracts sub-array", () => {
      const a = arr(mkSmi(10), mkSmi(20), mkSmi(30), mkSmi(40));
      const result = callMethod("slice", a, mkSmi(1), mkSmi(3));
      expect(elements(result)).toEqual([mkSmi(20), mkSmi(30)]);
    });

    it("join produces separator-delimited string", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3));
      const result = callMethod("join", a, mkString("-"));
      expect(getPayload(result)).toBe("1-2-3");
    });

    it("reverse mutates in place", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3));
      const result = callMethod("reverse", a);
      expect(result).toBe(a);
      expect(elements(a)).toEqual([mkSmi(3), mkSmi(2), mkSmi(1)]);
    });
  });

  describe("map/filter/reduce", () => {
    const interp = mockInterpreter();

    it("map transforms each element", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3));
      const double = mkFunction({ name: "double", call: (args) => mkSmi(getPayload(args[0]) * 2) });
      const result = callMethodWithInterp("map", a, interp, double);
      expect(elements(result)).toEqual([mkSmi(2), mkSmi(4), mkSmi(6)]);
    });

    it("filter keeps matching elements", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4));
      const isEven = mkFunction({ name: "isEven", call: (args) => mkBool(getPayload(args[0]) % 2 === 0) });
      const result = callMethodWithInterp("filter", a, interp, isEven);
      expect(elements(result)).toEqual([mkSmi(2), mkSmi(4)]);
    });

    it("reduce accumulates left-to-right", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3));
      const sum = mkFunction({ name: "sum", call: (args) => mkSmi(getPayload(args[0]) + getPayload(args[1])) });
      const result = callMethodWithInterp("reduce", a, interp, sum, mkSmi(0));
      expect(result).toBe(mkSmi(6));
    });

    it("reduce without initial value uses first element", () => {
      const a = arr(mkSmi(10), mkSmi(20));
      const sum = mkFunction({ name: "sum", call: (args) => mkSmi(getPayload(args[0]) + getPayload(args[1])) });
      const result = callMethodWithInterp("reduce", a, interp, sum);
      expect(result).toBe(mkSmi(30));
    });

    it("reduce throws on empty array without initial value", () => {
      const a = arr();
      const noop = mkFunction({ name: "noop", call: () => mkSmi(0) });
      expect(() => callMethodWithInterp("reduce", a, interp, noop)).toThrow(/empty array/);
    });
  });

  describe("find/findIndex/every/some", () => {
    const interp = mockInterpreter();

    it("find returns first matching element", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3));
      const gt1 = mkFunction({ name: "gt1", call: (args) => mkBool(getPayload(args[0]) > 1) });
      expect(callMethodWithInterp("find", a, interp, gt1)).toBe(mkSmi(2));
    });

    it("find returns undefined when nothing matches", () => {
      const a = arr(mkSmi(1));
      const never = mkFunction({ name: "never", call: () => mkBool(false) });
      expect(callMethodWithInterp("find", a, interp, never)).toBe(mkUndefined());
    });

    it("findIndex returns index of first match", () => {
      const a = arr(mkSmi(10), mkSmi(20), mkSmi(30));
      const gt15 = mkFunction({ name: "gt15", call: (args) => mkBool(getPayload(args[0]) > 15) });
      expect(callMethodWithInterp("findIndex", a, interp, gt15)).toBe(mkSmi(1));
    });

    it("every returns false if any element fails", () => {
      const a = arr(mkSmi(2), mkSmi(4), mkSmi(5));
      const isEven = mkFunction({ name: "isEven", call: (args) => mkBool(getPayload(args[0]) % 2 === 0) });
      expect(callMethodWithInterp("every", a, interp, isEven)).toBe(mkBool(false));
    });

    it("every returns true if all pass", () => {
      const a = arr(mkSmi(2), mkSmi(4));
      const isEven = mkFunction({ name: "isEven", call: (args) => mkBool(getPayload(args[0]) % 2 === 0) });
      expect(callMethodWithInterp("every", a, interp, isEven)).toBe(mkBool(true));
    });

    it("some returns true if any element passes", () => {
      const a = arr(mkSmi(1), mkSmi(3), mkSmi(4));
      const isEven = mkFunction({ name: "isEven", call: (args) => mkBool(getPayload(args[0]) % 2 === 0) });
      expect(callMethodWithInterp("some", a, interp, isEven)).toBe(mkBool(true));
    });

    it("some returns false if none pass", () => {
      const a = arr(mkSmi(1), mkSmi(3));
      const isEven = mkFunction({ name: "isEven", call: (args) => mkBool(getPayload(args[0]) % 2 === 0) });
      expect(callMethodWithInterp("some", a, interp, isEven)).toBe(mkBool(false));
    });
  });

  describe("flat/at/fill", () => {
    it("flat depth 1 flattens one level", () => {
      const inner = arr(mkSmi(3), mkSmi(4));
      const a = arr(mkSmi(1), mkSmi(2), inner);
      const result = callMethod("flat", a);
      expect(elements(result)).toEqual([mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4)]);
    });

    it("flat depth 0 does not flatten", () => {
      const inner = arr(mkSmi(2));
      const a = arr(mkSmi(1), inner);
      const result = ARRAY_METHODS.flat.call([mkSmi(0)], a);
      expect(elements(result)).toHaveLength(2);
    });

    it("at supports negative index", () => {
      const a = arr(mkSmi(10), mkSmi(20), mkSmi(30));
      expect(ARRAY_METHODS.at.call([mkSmi(-1)], a)).toBe(mkSmi(30));
      expect(ARRAY_METHODS.at.call([mkSmi(-2)], a)).toBe(mkSmi(20));
    });

    it("at returns undefined for out of range", () => {
      const a = arr(mkSmi(1));
      expect(ARRAY_METHODS.at.call([mkSmi(5)], a)).toBe(mkUndefined());
      expect(ARRAY_METHODS.at.call([mkSmi(-5)], a)).toBe(mkUndefined());
    });

    it("fill overwrites range", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4));
      ARRAY_METHODS.fill.call([mkSmi(0), mkSmi(1), mkSmi(3)], a);
      expect(elements(a)).toEqual([mkSmi(1), mkSmi(0), mkSmi(0), mkSmi(4)]);
    });

    it("fill with negative start wraps from end", () => {
      const a = arr(mkSmi(1), mkSmi(2), mkSmi(3));
      ARRAY_METHODS.fill.call([mkSmi(9), mkSmi(-1)], a);
      expect(elements(a)).toEqual([mkSmi(1), mkSmi(2), mkSmi(9)]);
    });
  });

  describe("sort", () => {
    it("sort without comparator sorts by string representation", () => {
      const a = arr(mkSmi(3), mkSmi(1), mkSmi(2));
      callMethod("sort", a);
      const sorted = elements(a).map((v) => getPayload(v));
      expect(sorted).toEqual([1, 2, 3]);
    });

    it("sort with comparator uses custom order", () => {
      const interp = mockInterpreter();
      const a = arr(mkSmi(3), mkSmi(1), mkSmi(2));
      const desc = mkFunction({
        name: "desc",
        call: (args) => mkSmi(getPayload(args[1]) - getPayload(args[0])),
      });
      callMethodWithInterp("sort", a, interp, desc);
      expect(elements(a).map((v) => getPayload(v))).toEqual([3, 2, 1]);
    });
  });

  describe("forEach", () => {
    it("calls callback for each element with index", () => {
      const interp = mockInterpreter();
      const a = arr(mkSmi(10), mkSmi(20));
      const collected = [];
      const cb = mkFunction({
        name: "cb",
        call: (args) => {
          collected.push([getPayload(args[0]), getPayload(args[1])]);
          return mkUndefined();
        },
      });
      callMethodWithInterp("forEach", a, interp, cb);
      expect(collected).toEqual([[10, 0], [20, 1]]);
    });
  });

  describe("falsy element 0 is not treated as a hole", () => {
    it("map yields the real value for a zero element", () => {
      const a = arr(mkSmi(7), mkSmi(0), mkSmi(3));
      const interp = mockInterpreter();
      const identity = mkFunction({ name: "id", call: (args) => args[0] });
      const result = callMethodWithInterp("map", a, interp, identity);
      expect(elements(result).map((v) => getPayload(v))).toEqual([7, 0, 3]);
    });

    it("reduce sums an array containing zero", () => {
      const a = arr(mkSmi(0), mkSmi(5), mkSmi(2));
      const interp = mockInterpreter();
      const sum = mkFunction({
        name: "sum",
        call: (args) => mkSmi(getPayload(args[0]) + getPayload(args[1])),
      });
      const result = callMethodWithInterp("reduce", a, interp, sum, mkSmi(0));
      expect(getPayload(result)).toBe(7);
    });

    it("indexOf finds a zero element", () => {
      const a = arr(mkSmi(1), mkSmi(0), mkSmi(2));
      expect(getPayload(callMethod("indexOf", a, mkSmi(0)))).toBe(1);
    });

    it("includes detects a zero element", () => {
      const a = arr(mkSmi(1), mkSmi(0), mkSmi(2));
      expect(getPayload(callMethod("includes", a, mkSmi(0)))).toBe(true);
    });
  });
});
