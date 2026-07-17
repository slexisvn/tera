import { describe, it, expect } from "vitest";
import { STRING_METHODS } from "../../../src/runtime/intrinsics/string-methods.js";
import {
  mkSmi,
  mkString,
  mkBool,
  mkUndefined,
  mkArray,
  mkFunction,
  mkRegex,
  mkNull,
  getPayload,
  toNumber,
  isArray,
  isNull,
} from "../../../src/core/value/index.js";

function s(str) {
  return mkString(str);
}

function callMethod(name, thisVal, ...args) {
  return STRING_METHODS[name].call(args, thisVal);
}

function str(val) {
  return getPayload(val);
}

function arrElements(val) {
  const a = getPayload(val);
  const result = [];
  for (let i = 0; i < a.getLength(); i++) result.push(a.getIndex(i));
  return result;
}

describe("STRING_METHODS", () => {
  describe("charAt/charCodeAt", () => {
    it("charAt returns character at index", () => {
      expect(str(callMethod("charAt", s("hello"), mkSmi(1)))).toBe("e");
    });

    it("charAt default index is 0", () => {
      expect(str(callMethod("charAt", s("abc")))).toBe("a");
    });

    it("charCodeAt returns character code", () => {
      expect(getPayload(callMethod("charCodeAt", s("A"), mkSmi(0)))).toBe(65);
    });
  });

  describe("substring/slice", () => {
    it("substring extracts range", () => {
      expect(str(callMethod("substring", s("hello world"), mkSmi(6), mkSmi(11)))).toBe("world");
    });

    it("substring with no end goes to end of string", () => {
      expect(str(callMethod("substring", s("abcdef"), mkSmi(3)))).toBe("def");
    });

    it("slice with negative indices wraps from end", () => {
      expect(str(callMethod("slice", s("hello"), mkSmi(-3)))).toBe("llo");
      expect(str(callMethod("slice", s("hello"), mkSmi(1), mkSmi(-1)))).toBe("ell");
    });
  });

  describe("indexOf/lastIndexOf/includes/startsWith/endsWith", () => {
    it("indexOf finds first occurrence", () => {
      expect(callMethod("indexOf", s("abcabc"), s("bc"))).toBe(mkSmi(1));
    });

    it("indexOf returns -1 for missing", () => {
      expect(callMethod("indexOf", s("abc"), s("z"))).toBe(mkSmi(-1));
    });

    it("lastIndexOf finds last occurrence", () => {
      expect(callMethod("lastIndexOf", s("abcabc"), s("bc"))).toBe(mkSmi(4));
    });

    it("includes/startsWith/endsWith return correct booleans", () => {
      const val = s("hello world");
      expect(callMethod("includes", val, s("lo w"))).toBe(mkBool(true));
      expect(callMethod("includes", val, s("xyz"))).toBe(mkBool(false));
      expect(callMethod("startsWith", val, s("hello"))).toBe(mkBool(true));
      expect(callMethod("startsWith", val, s("world"))).toBe(mkBool(false));
      expect(callMethod("endsWith", val, s("world"))).toBe(mkBool(true));
      expect(callMethod("endsWith", val, s("hello"))).toBe(mkBool(false));
    });
  });

  describe("split", () => {
    it("splits by string separator", () => {
      const result = callMethod("split", s("a-b-c"), s("-"));
      const parts = arrElements(result).map((v) => str(v));
      expect(parts).toEqual(["a", "b", "c"]);
    });

    it("splits by regex", () => {
      const regex = mkRegex(new RegExp("\\d+"));
      const result = callMethod("split", s("a1b2c"), regex);
      const parts = arrElements(result).map((v) => str(v));
      expect(parts).toEqual(["a", "b", "c"]);
    });

    it("split with no separator returns whole string", () => {
      const result = callMethod("split", s("abc"));
      const parts = arrElements(result).map((v) => str(v));
      expect(parts).toEqual(["abc"]);
    });
  });

  describe("replace/replaceAll", () => {
    it("replace substitutes first occurrence", () => {
      const result = callMethod("replace", s("aaa"), s("a"), s("b"));
      expect(str(result)).toBe("baa");
    });

    it("replace with regex", () => {
      const regex = mkRegex(new RegExp("\\d+"));
      const result = callMethod("replace", s("abc123def"), regex, s("X"));
      expect(str(result)).toBe("abcXdef");
    });

    it("replaceAll replaces all occurrences", () => {
      const result = callMethod("replaceAll", s("aabaa"), s("a"), s("x"));
      expect(str(result)).toBe("xxbxx");
    });

    it("replaceAll with global regex", () => {
      const regex = mkRegex(new RegExp("\\d", "g"));
      const result = callMethod("replaceAll", s("a1b2c3"), regex, s("X"));
      expect(str(result)).toBe("aXbXcX");
    });
  });

  describe("match/search", () => {
    it("match returns array of matches", () => {
      const regex = mkRegex(new RegExp("\\d+", "g"));
      const result = callMethod("match", s("a1b22c333"), regex);
      expect(isArray(result)).toBe(true);
      const matches = arrElements(result).map((v) => str(v));
      expect(matches).toEqual(["1", "22", "333"]);
    });

    it("match returns null on no match", () => {
      const regex = mkRegex(new RegExp("\\d+"));
      const result = callMethod("match", s("abc"), regex);
      expect(isNull(result)).toBe(true);
    });

    it("search returns index of first match", () => {
      const regex = mkRegex(new RegExp("\\d+"));
      expect(callMethod("search", s("abc123"), regex)).toBe(mkSmi(3));
    });

    it("search returns -1 on no match", () => {
      const regex = mkRegex(new RegExp("\\d+"));
      expect(callMethod("search", s("abc"), regex)).toBe(mkSmi(-1));
    });
  });

  describe("trim/case", () => {
    it("trim removes leading and trailing whitespace", () => {
      expect(str(callMethod("trim", s("  hello  ")))).toBe("hello");
    });

    it("trimStart only trims leading", () => {
      expect(str(callMethod("trimStart", s("  hello  ")))).toBe("hello  ");
    });

    it("trimEnd only trims trailing", () => {
      expect(str(callMethod("trimEnd", s("  hello  ")))).toBe("  hello");
    });

    it("toLowerCase/toUpperCase convert case", () => {
      expect(str(callMethod("toLowerCase", s("Hello World")))).toBe("hello world");
      expect(str(callMethod("toUpperCase", s("Hello World")))).toBe("HELLO WORLD");
    });
  });

  describe("repeat/padStart/padEnd/concat/at", () => {
    it("repeat duplicates string N times", () => {
      expect(str(callMethod("repeat", s("ab"), mkSmi(3)))).toBe("ababab");
    });

    it("padStart pads to target length", () => {
      expect(str(callMethod("padStart", s("5"), mkSmi(3), s("0")))).toBe("005");
    });

    it("padEnd pads to target length", () => {
      expect(str(callMethod("padEnd", s("5"), mkSmi(3), s("0")))).toBe("500");
    });

    it("concat joins strings", () => {
      expect(str(callMethod("concat", s("hello"), s(" "), s("world")))).toBe("hello world");
    });

    it("at with positive and negative index", () => {
      expect(str(callMethod("at", s("abcde"), mkSmi(0)))).toBe("a");
      expect(str(callMethod("at", s("abcde"), mkSmi(-1)))).toBe("e");
      expect(str(callMethod("at", s("abcde"), mkSmi(-2)))).toBe("d");
    });

    it("at returns undefined for out of range", () => {
      expect(callMethod("at", s("abc"), mkSmi(10))).toBe(mkUndefined());
      expect(callMethod("at", s("abc"), mkSmi(-10))).toBe(mkUndefined());
    });
  });

  describe("charCodeAt out of range", () => {
    it("returns NaN when index is past the end", () => {
      const r = callMethod("charCodeAt", s(""), mkSmi(0));
      expect(Number.isNaN(toNumber(r))).toBe(true);
    });

    it("returns NaN for negative index", () => {
      const r = callMethod("charCodeAt", s("ab"), mkSmi(-1));
      expect(Number.isNaN(toNumber(r))).toBe(true);
    });

    it("returns the code for an in-range index", () => {
      expect(toNumber(callMethod("charCodeAt", s("A"), mkSmi(0)))).toBe(65);
    });
  });

  describe("toString/valueOf", () => {
    it("toString ignores any radix argument and returns the string", () => {
      expect(str(callMethod("toString", s("123"), mkSmi(2)))).toBe("123");
    });

    it("valueOf returns the underlying string", () => {
      expect(str(callMethod("valueOf", s("abc")))).toBe("abc");
    });
  });
});
