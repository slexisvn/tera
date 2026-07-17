import { describe, it, expect } from "vitest";
import { JSArray } from "../../../src/objects/heap/js-array.js";
import { mkSmi, mkString, mkDouble, mkUndefined, getPayload, strictEqual } from "../../../src/core/value/index.js";

describe("JSArray", () => {
  describe("basic indexing", () => {
    it("getIndex/setIndex round-trip, fills holes with undefined", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2)]);
      expect(getPayload(arr.getIndex(0))).toBe(1);
      expect(getPayload(arr.getIndex(1))).toBe(2);
      expect(arr.getIndex(5)).toBeUndefined();

      arr.setIndex(4, mkSmi(99));
      expect(arr.getLength()).toBe(5);
      expect(arr.getIndex(2)).toBeUndefined();
      expect(arr.getIndex(3)).toBeUndefined();
      expect(getPayload(arr.getIndex(4))).toBe(99);
    });
  });

  describe("push/pop/shift/unshift", () => {
    it("push appends and returns new length", () => {
      const arr = new JSArray([]);
      expect(arr.push(mkSmi(1), mkSmi(2))).toBe(2);
      expect(arr.push(mkSmi(3))).toBe(3);
      expect(getPayload(arr.getIndex(2))).toBe(3);
    });

    it("pop removes last element, returns undefined on empty", () => {
      const arr = new JSArray([mkSmi(10), mkSmi(20)]);
      expect(getPayload(arr.pop())).toBe(20);
      expect(getPayload(arr.pop())).toBe(10);
      expect(arr.pop()).toBeUndefined();
    });

    it("shift removes first element", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      expect(getPayload(arr.shift())).toBe(1);
      expect(arr.getLength()).toBe(2);
      expect(getPayload(arr.getIndex(0))).toBe(2);
    });

    it("unshift prepends and returns new length", () => {
      const arr = new JSArray([mkSmi(3)]);
      expect(arr.unshift(mkSmi(1), mkSmi(2))).toBe(3);
      expect(getPayload(arr.getIndex(0))).toBe(1);
      expect(getPayload(arr.getIndex(1))).toBe(2);
      expect(getPayload(arr.getIndex(2))).toBe(3);
    });
  });

  describe("splice", () => {
    it("removes elements and inserts new ones, returns removed", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4)]);
      const removed = arr.splice(1, 2, mkSmi(20), mkSmi(30), mkSmi(40));
      expect(removed.map(v => getPayload(v))).toEqual([2, 3]);
      expect(arr.getLength()).toBe(5);
      expect(getPayload(arr.getIndex(1))).toBe(20);
      expect(getPayload(arr.getIndex(2))).toBe(30);
      expect(getPayload(arr.getIndex(3))).toBe(40);
      expect(getPayload(arr.getIndex(4))).toBe(4);
    });

    it("handles negative start index", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      const removed = arr.splice(-1, 1);
      expect(removed.map(v => getPayload(v))).toEqual([3]);
      expect(arr.getLength()).toBe(2);
    });

    it("deleteCount=undefined removes to end", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      const removed = arr.splice(1);
      expect(removed).toHaveLength(2);
      expect(arr.getLength()).toBe(1);
    });
  });

  describe("indexOf/includes", () => {
    it("indexOf finds by strict equality, returns -1 on miss", () => {
      const a = mkSmi(10);
      const b = mkSmi(20);
      const c = mkSmi(30);
      const arr = new JSArray([a, b, c]);
      expect(arr.indexOf(b)).toBe(1);
      expect(arr.indexOf(mkSmi(99))).toBe(-1);
    });

    it("indexOf supports negative fromIndex", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(2)]);
      expect(arr.indexOf(mkSmi(2), -2)).toBe(3);
    });

    it("includes returns boolean", () => {
      const v = mkSmi(5);
      const arr = new JSArray([mkSmi(1), v, mkSmi(3)]);
      expect(arr.includes(v)).toBe(true);
      expect(arr.includes(mkSmi(99))).toBe(false);
    });
  });

  describe("setLength", () => {
    it("truncates when new length is shorter", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      arr.setLength(1);
      expect(arr.getLength()).toBe(1);
      expect(arr.getIndex(1)).toBeUndefined();
    });

    it("extends with undefined when new length is longer", () => {
      const arr = new JSArray([mkSmi(1)]);
      arr.setLength(3);
      expect(arr.getLength()).toBe(3);
      expect(arr.getIndex(1)).toBeUndefined();
    });
  });

  describe("slice/concat/reverse/join", () => {
    it("slice returns new JSArray with correct range, supports negative indices", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4)]);
      const sliced = arr.slice(1, 3);
      expect(sliced.getLength()).toBe(2);
      expect(getPayload(sliced.getIndex(0))).toBe(2);
      expect(getPayload(sliced.getIndex(1))).toBe(3);

      const fromEnd = arr.slice(-2);
      expect(fromEnd.getLength()).toBe(2);
      expect(getPayload(fromEnd.getIndex(0))).toBe(3);
    });

    it("concat merges arrays and single values", () => {
      const a = new JSArray([mkSmi(1)]);
      const b = new JSArray([mkSmi(2), mkSmi(3)]);
      const result = a.concat(b, mkSmi(4));
      expect(result.getLength()).toBe(4);
      expect(getPayload(result.getIndex(3))).toBe(4);
    });

    it("reverse mutates in-place and returns this", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      const ret = arr.reverse();
      expect(ret).toBe(arr);
      expect(getPayload(arr.getIndex(0))).toBe(3);
      expect(getPayload(arr.getIndex(2))).toBe(1);
    });

    it("join with separator", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      expect(arr.join("-")).toBe("1-2-3");
      expect(arr.join()).toBe("1,2,3");
    });
  });

  describe("higher-order methods (map/filter/reduce/find/findIndex/forEach)", () => {
    it("map transforms elements into new JSArray", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      const mapped = arr.map((el) => mkSmi(getPayload(el) * 10));
      expect(mapped.getLength()).toBe(3);
      expect(getPayload(mapped.getIndex(0))).toBe(10);
      expect(getPayload(mapped.getIndex(2))).toBe(30);
    });

    it("filter keeps elements matching predicate", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4)]);
      const even = arr.filter((el) => getPayload(el) % 2 === 0);
      expect(even.getLength()).toBe(2);
      expect(getPayload(even.getIndex(0))).toBe(2);
      expect(getPayload(even.getIndex(1))).toBe(4);
    });

    it("reduce accumulates with initial value", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      const sum = arr.reduce((acc, el) => mkSmi(getPayload(acc) + getPayload(el)), mkSmi(0));
      expect(getPayload(sum)).toBe(6);
    });

    it("reduce without initial value uses first element", () => {
      const arr = new JSArray([mkSmi(10), mkSmi(20)]);
      const sum = arr.reduce((acc, el) => mkSmi(getPayload(acc) + getPayload(el)));
      expect(getPayload(sum)).toBe(30);
    });

    it("reduce throws on empty array without initial value", () => {
      const arr = new JSArray([]);
      expect(() => arr.reduce((a, b) => a)).toThrow();
    });

    it("find returns first match, findIndex returns its index", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      const found = arr.find((el) => getPayload(el) === 2);
      expect(getPayload(found)).toBe(2);
      expect(arr.findIndex((el) => getPayload(el) === 3)).toBe(2);
      expect(arr.findIndex((el) => getPayload(el) === 99)).toBe(-1);
    });

    it("forEach visits all elements with correct index", () => {
      const arr = new JSArray([mkSmi(10), mkSmi(20)]);
      const visited = [];
      arr.forEach((el, i) => visited.push({ val: getPayload(el), i }));
      expect(visited).toEqual([{ val: 10, i: 0 }, { val: 20, i: 1 }]);
    });
  });

  describe("sort", () => {
    it("sorts with custom compareFn", () => {
      const arr = new JSArray([mkSmi(3), mkSmi(1), mkSmi(2)]);
      arr.sort((a, b) => getPayload(a) - getPayload(b));
      expect(getPayload(arr.getIndex(0))).toBe(1);
      expect(getPayload(arr.getIndex(1))).toBe(2);
      expect(getPayload(arr.getIndex(2))).toBe(3);
    });

    it("default sort is lexicographic via toDisplayString", () => {
      const arr = new JSArray([mkSmi(10), mkSmi(2), mkSmi(1)]);
      arr.sort();
      expect(getPayload(arr.getIndex(0))).toBe(1);
      expect(getPayload(arr.getIndex(1))).toBe(10);
      expect(getPayload(arr.getIndex(2))).toBe(2);
    });
  });

  describe("named properties (via hidden class)", () => {
    it("getProperty('length') returns element count", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2)]);
      expect(arr.getProperty("length")).toBe(2);
    });

    it("setProperty('length', n) truncates/extends", () => {
      const arr = new JSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      arr.setProperty("length", mkSmi(1));
      expect(arr.getLength()).toBe(1);
    });

    it("setProperty/getProperty for non-length named props via hidden class transitions", () => {
      const arr = new JSArray([]);
      arr.setProperty("custom", mkSmi(42));
      expect(arr.getProperty("custom")).toBe(mkSmi(42));
    });
  });
});
