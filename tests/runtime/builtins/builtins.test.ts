import { describe, it, expect } from "vitest";
import { builtins } from "../../../src/runtime/builtins/index.js";
import {
  mkSmi,
  mkDouble,
  mkString,
  mkBool,
  mkUndefined,
  mkNull,
  mkArray,
  mkObject,
  mkNumber,
  mkSymbol,
  mkRegex,
  getPayload,
  toNumber,
  isArray,
  isObject,
  isString,
  isNull,
  isUndefined,
  isSymbol,
  isBool,
  JSSymbol,
  symbolFor,
} from "../../../src/core/value/index.js";
import { createJSArray, createJSObject } from "../../../src/objects/heap/factory.js";

describe("builtins", () => {
  describe("parseInt", () => {
    it("parses decimal and radix variants", () => {
      const cases = [
        [["42"], 42],
        [["0xFF", mkSmi(16)], 255],
        [["111", mkSmi(2)], 7],
        [["77", mkSmi(8)], 63],
        [["abc"], NaN],
      ];
      for (const [args, expected] of cases) {
        const result = toNumber(builtins.parseInt.call(args.map(a => typeof a === "string" ? mkString(a) : a)));
        if (Number.isNaN(expected)) {
          expect(Number.isNaN(result)).toBe(true);
        } else {
          expect(result).toBe(expected);
        }
      }
    });
  });

  describe("parseFloat", () => {
    it("parses float strings", () => {
      expect(toNumber(builtins.parseFloat.call([mkString("3.14")]))).toBeCloseTo(3.14);
      expect(toNumber(builtins.parseFloat.call([mkString("42")]))).toBe(42);
      expect(Number.isNaN(toNumber(builtins.parseFloat.call([mkString("abc")])))).toBe(true);
    });
  });

  describe("isNaN / isFinite", () => {
    it("isNaN detects NaN values", () => {
      expect(builtins.isNaN.call([mkDouble(NaN)])).toBe(mkBool(true));
      expect(builtins.isNaN.call([mkSmi(42)])).toBe(mkBool(false));
      expect(builtins.isNaN.call([mkDouble(Infinity)])).toBe(mkBool(false));
    });

    it("isFinite detects finite values", () => {
      expect(builtins.isFinite.call([mkSmi(42)])).toBe(mkBool(true));
      expect(builtins.isFinite.call([mkDouble(Infinity)])).toBe(mkBool(false));
      expect(builtins.isFinite.call([mkDouble(NaN)])).toBe(mkBool(false));
    });
  });

  describe("Math", () => {
    it("abs/floor/ceil/round/trunc/sign handle edge cases", () => {
      expect(toNumber(builtins.Math.abs.call([mkSmi(-5)]))).toBe(5);
      expect(toNumber(builtins.Math.abs.call([mkSmi(5)]))).toBe(5);
      expect(toNumber(builtins.Math.floor.call([mkDouble(3.7)]))).toBe(3);
      expect(toNumber(builtins.Math.floor.call([mkDouble(-3.2)]))).toBe(-4);
      expect(toNumber(builtins.Math.ceil.call([mkDouble(3.2)]))).toBe(4);
      expect(toNumber(builtins.Math.round.call([mkDouble(3.5)]))).toBe(4);
      expect(toNumber(builtins.Math.round.call([mkDouble(3.4)]))).toBe(3);
      expect(toNumber(builtins.Math.trunc.call([mkDouble(3.9)]))).toBe(3);
      expect(toNumber(builtins.Math.trunc.call([mkDouble(-3.9)]))).toBe(-3);
      expect(toNumber(builtins.Math.sign.call([mkSmi(10)]))).toBe(1);
      expect(toNumber(builtins.Math.sign.call([mkSmi(-10)]))).toBe(-1);
      expect(toNumber(builtins.Math.sign.call([mkSmi(0)]))).toBe(0);
    });

    it("sqrt/log/pow compute correctly", () => {
      expect(toNumber(builtins.Math.sqrt.call([mkSmi(9)]))).toBe(3);
      expect(toNumber(builtins.Math.log.call([mkDouble(Math.E)]))).toBeCloseTo(1);
      expect(toNumber(builtins.Math.pow.call([mkSmi(2), mkSmi(10)]))).toBe(1024);
      expect(toNumber(builtins.Math.pow.call([mkSmi(3), mkSmi(0)]))).toBe(1);
    });

    it("min/max with multiple args, no args, and NaN propagation", () => {
      expect(toNumber(builtins.Math.min.call([mkSmi(3), mkSmi(1), mkSmi(2)]))).toBe(1);
      expect(toNumber(builtins.Math.max.call([mkSmi(3), mkSmi(1), mkSmi(2)]))).toBe(3);
      expect(toNumber(builtins.Math.min.call([]))).toBe(Infinity);
      expect(toNumber(builtins.Math.max.call([]))).toBe(-Infinity);
      expect(Number.isNaN(toNumber(builtins.Math.min.call([mkSmi(1), mkDouble(NaN)])))).toBe(true);
      expect(Number.isNaN(toNumber(builtins.Math.max.call([mkSmi(1), mkDouble(NaN)])))).toBe(true);
    });
  });

  describe("Array", () => {
    it("isArray distinguishes arrays from non-arrays", () => {
      expect(builtins.Array.isArray.call([mkArray(createJSArray([]))])).toBe(mkBool(true));
      expect(builtins.Array.isArray.call([mkSmi(1)])).toBe(mkBool(false));
      expect(builtins.Array.isArray.call([mkObject(createJSObject())])).toBe(mkBool(false));
    });

    it("from clones array elements", () => {
      const src = mkArray(createJSArray([mkSmi(1), mkSmi(2)]));
      const result = builtins.Array.from.call([src]);
      expect(isArray(result)).toBe(true);
      const arr = getPayload(result);
      expect(arr.getLength()).toBe(2);
      expect(arr.getIndex(0)).toBe(mkSmi(1));
    });

    it("from splits string into characters", () => {
      const result = builtins.Array.from.call([mkString("abc")]);
      const arr = getPayload(result);
      expect(arr.getLength()).toBe(3);
      expect(getPayload(arr.getIndex(0))).toBe("a");
      expect(getPayload(arr.getIndex(2))).toBe("c");
    });

    it("from returns empty array for non-iterable", () => {
      const result = builtins.Array.from.call([mkSmi(42)]);
      expect(getPayload(result).getLength()).toBe(0);
    });

    it("push appends to array and returns new length", () => {
      const a = mkArray(createJSArray([mkSmi(1)]));
      const len = builtins.Array.push.call([a, mkSmi(2), mkSmi(3)]);
      expect(getPayload(len)).toBe(3);
    });

    it("pop removes last element", () => {
      const a = mkArray(createJSArray([mkSmi(10), mkSmi(20)]));
      const val = builtins.Array.pop.call([a]);
      expect(val).toBe(mkSmi(20));
      expect(getPayload(a).getLength()).toBe(1);
    });
  });

  describe("Object", () => {
    it("freeze and isFrozen", () => {
      const obj = mkObject(createJSObject());
      expect(builtins.Object.isFrozen.call([obj])).toBe(mkBool(false));
      builtins.Object.freeze.call([obj]);
      expect(builtins.Object.isFrozen.call([obj])).toBe(mkBool(true));
    });

    it("isFrozen returns true for non-objects", () => {
      expect(builtins.Object.isFrozen.call([mkSmi(1)])).toBe(mkBool(true));
      expect(builtins.Object.isFrozen.call([])).toBe(mkBool(true));
    });

    it("create sets prototype", () => {
      const proto = mkObject(createJSObject());
      const obj = builtins.Object.create.call([proto]);
      expect(isObject(obj)).toBe(true);
      expect(getPayload(obj).prototype).toBe(getPayload(proto));
    });
  });

  describe("JSON", () => {
    it("parse converts JSON string to tagged value tree", () => {
      const result = builtins.JSON.parse.call([mkString('{"a":1,"b":"hello"}')]);
      expect(isObject(result)).toBe(true);
      const obj = getPayload(result);
      expect(toNumber(obj.getProperty("a"))).toBe(1);
      expect(getPayload(obj.getProperty("b"))).toBe("hello");
    });

    it("parse handles arrays", () => {
      const result = builtins.JSON.parse.call([mkString("[1,2,3]")]);
      expect(isArray(result)).toBe(true);
      const arr = getPayload(result);
      expect(arr.getLength()).toBe(3);
    });

    it("parse handles primitives", () => {
      expect(toNumber(builtins.JSON.parse.call([mkString("42")]))).toBe(42);
      expect(getPayload(builtins.JSON.parse.call([mkString('"hello"')]))).toBe("hello");
      expect(isNull(builtins.JSON.parse.call([mkString("null")]))).toBe(true);
      expect(getPayload(builtins.JSON.parse.call([mkString("true")]))).toBe(true);
    });

    it("parse throws on invalid JSON", () => {
      expect(() => builtins.JSON.parse.call([mkString("{invalid}")])).toThrow(/SyntaxError/);
    });

    it("stringify converts tagged values to JSON string", () => {
      const obj = createJSObject();
      obj.setProperty("x", mkSmi(1));
      obj.setProperty("y", mkString("hello"));
      const result = builtins.JSON.stringify.call([mkObject(obj)]);
      const parsed = JSON.parse(getPayload(result));
      expect(parsed).toEqual({ x: 1, y: "hello" });
    });

    it("stringify handles arrays and nested objects", () => {
      const inner = createJSObject();
      inner.setProperty("z", mkSmi(3));
      const arr = createJSArray([mkSmi(1), mkObject(inner)]);
      const result = builtins.JSON.stringify.call([mkArray(arr)]);
      expect(JSON.parse(getPayload(result))).toEqual([1, { z: 3 }]);
    });

    it("stringify returns undefined for no args", () => {
      expect(isUndefined(builtins.JSON.stringify.call([]))).toBe(true);
    });

    it("stringify with array replacer filters keys", () => {
      const obj = createJSObject();
      obj.setProperty("a", mkSmi(1));
      obj.setProperty("b", mkSmi(2));
      obj.setProperty("c", mkSmi(3));
      const allowedKeys = mkArray(createJSArray([mkString("a"), mkString("c")]));
      const result = builtins.JSON.stringify.call([mkObject(obj), allowedKeys]);
      expect(JSON.parse(getPayload(result))).toEqual({ a: 1, c: 3 });
    });
  });

  describe("Symbol", () => {
    it("creates unique symbols", () => {
      const s1 = builtins.Symbol.call([mkString("test")]);
      const s2 = builtins.Symbol.call([mkString("test")]);
      expect(isSymbol(s1)).toBe(true);
      expect(s1).not.toBe(s2);
    });

    it("Symbol.for returns same symbol for same key", () => {
      const s1 = builtins.Symbol.for.call([mkString("shared")]);
      const s2 = builtins.Symbol.for.call([mkString("shared")]);
      expect(s1).toBe(s2);
    });

    it("Symbol.keyFor returns key for registered symbol", () => {
      const sym = builtins.Symbol.for.call([mkString("myKey")]);
      const key = builtins.Symbol.keyFor.call([sym]);
      expect(getPayload(key)).toBe("myKey");
    });

    it("Symbol.keyFor returns undefined for unregistered symbol", () => {
      const sym = builtins.Symbol.call([mkString("local")]);
      expect(isUndefined(builtins.Symbol.keyFor.call([sym]))).toBe(true);
    });
  });

  describe("Number / Boolean / String constructors", () => {
    it("Number converts to number", () => {
      expect(toNumber(builtins.Number.call([mkString("42")]))).toBe(42);
      expect(builtins.Number.call([])).toBe(mkSmi(0));
    });

    it("Boolean converts to boolean", () => {
      expect(builtins.Boolean.call([mkSmi(0)])).toBe(mkBool(false));
      expect(builtins.Boolean.call([mkSmi(1)])).toBe(mkBool(true));
      expect(builtins.Boolean.call([])).toBe(mkBool(false));
    });

    it("String converts to string", () => {
      expect(getPayload(builtins.String.call([mkSmi(42)]))).toBe("42");
      expect(getPayload(builtins.String.call([]))).toBe("");
    });
  });

  describe("RegExp", () => {
    it("creates regex from pattern and flags", () => {
      const re = builtins.RegExp.call([mkString("\\d+"), mkString("g")]);
      const rv = getPayload(re);
      expect(rv.nativeRegex.source).toBe("\\d+");
      expect(rv.nativeRegex.flags).toBe("g");
    });

    it("construct creates same result as call", () => {
      const re = builtins.RegExp.construct([mkString("abc"), mkString("i")]);
      const rv = getPayload(re);
      expect(rv.nativeRegex.source).toBe("abc");
      expect(rv.nativeRegex.flags).toBe("i");
    });
  });

  describe("typeof", () => {
    it("returns correct type strings", () => {
      const cases = [
        [mkSmi(1), "number"],
        [mkString("x"), "string"],
        [mkBool(true), "boolean"],
        [mkNull(), "object"],
        [mkUndefined(), "undefined"],
        [mkObject(createJSObject()), "object"],
        [mkArray(createJSArray([])), "object"],
      ];
      for (const [val, expected] of cases) {
        expect(getPayload(builtins.typeof.call([val]))).toBe(expected);
      }
    });
  });

  describe("String", () => {
    it("empty args yields empty string", () => {
      expect(getPayload(builtins.String.call([]))).toBe("");
    });

    it("uses spec ToString for numbers and booleans", () => {
      expect(getPayload(builtins.String.call([mkSmi(42)]))).toBe("42");
      expect(getPayload(builtins.String.call([mkBool(true)]))).toBe("true");
    });

    it("joins array elements with commas, not the debug form", () => {
      const arr = mkArray(createJSArray([mkSmi(0), mkSmi(5), mkSmi(9)]));
      expect(getPayload(builtins.String.call([arr]))).toBe("0,5,9");
    });

    it("renders empty array as empty string", () => {
      const arr = mkArray(createJSArray([]));
      expect(getPayload(builtins.String.call([arr]))).toBe("");
    });

    it("renders a plain object as [object Object]", () => {
      const obj = mkObject(createJSObject());
      expect(getPayload(builtins.String.call([obj]))).toBe("[object Object]");
    });
  });
});
