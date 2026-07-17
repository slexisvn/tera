import { describe, it, expect } from "vitest";
import { REGEX_METHODS, getRegexProperty } from "../../../src/runtime/intrinsics/regex-methods.js";
import {
  mkRegex,
  mkString,
  mkSmi,
  mkBool,
  mkNull,
  getPayload,
  isNull,
  isArray,
} from "../../../src/core/value/index.js";

function callMethod(name, thisVal, ...args) {
  return REGEX_METHODS[name].call(args, thisVal);
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

describe("REGEX_METHODS", () => {
  describe("test", () => {
    it("returns true/false for match presence", () => {
      const re = mkRegex(new RegExp("\\d+"));
      expect(callMethod("test", re, mkString("abc123"))).toBe(mkBool(true));
      expect(callMethod("test", re, mkString("abc"))).toBe(mkBool(false));
    });

    it("global regex advances lastIndex across calls", () => {
      const re = mkRegex(new RegExp("\\d+", "g"));
      const rv = getPayload(re);
      callMethod("test", re, mkString("a1b2c3"));
      const after1 = rv.lastIndex;
      callMethod("test", re, mkString("a1b2c3"));
      const after2 = rv.lastIndex;
      expect(after2).toBeGreaterThan(after1);
    });
  });

  describe("exec", () => {
    it("returns array of match groups", () => {
      const re = mkRegex(new RegExp("(\\d+)-(\\w+)"));
      const result = callMethod("exec", re, mkString("abc 42-hello xyz"));
      expect(isArray(result)).toBe(true);
      const els = arrElements(result).map(v => str(v));
      expect(els[0]).toBe("42-hello");
      expect(els[1]).toBe("42");
      expect(els[2]).toBe("hello");
    });

    it("returns null on no match", () => {
      const re = mkRegex(new RegExp("xyz"));
      expect(isNull(callMethod("exec", re, mkString("abc")))).toBe(true);
    });

    it("global regex iterates matches via lastIndex", () => {
      const re = mkRegex(new RegExp("\\d+", "g"));
      const results = [];
      for (let i = 0; i < 5; i++) {
        const r = callMethod("exec", re, mkString("a1b22c333"));
        if (isNull(r)) break;
        results.push(str(arrElements(r)[0]));
      }
      expect(results).toEqual(["1", "22", "333"]);
    });
  });

  describe("toString", () => {
    it("formats as /pattern/flags", () => {
      expect(str(callMethod("toString", mkRegex(new RegExp("abc", "gi"))))).toBe("/abc/gi");
      expect(str(callMethod("toString", mkRegex(new RegExp("\\d+", ""))))).toBe("/\\d+/");
    });
  });
});

describe("getRegexProperty", () => {
  it("returns source and flags as strings", () => {
    const rv = getPayload(mkRegex(new RegExp("abc", "gi")));
    expect(str(getRegexProperty("source", rv))).toBe("abc");
    expect(str(getRegexProperty("flags", rv))).toBe("gi");
  });

  it("returns lastIndex as smi", () => {
    const rv = getPayload(mkRegex(new RegExp("x", "g")));
    expect(getRegexProperty("lastIndex", rv)).toBe(mkSmi(0));
  });

  it("returns boolean for flag properties", () => {
    const rv = getPayload(mkRegex(new RegExp("x", "gi")));
    expect(getRegexProperty("global", rv)).toBe(mkBool(true));
    expect(getRegexProperty("ignoreCase", rv)).toBe(mkBool(true));
    expect(getRegexProperty("multiline", rv)).toBe(mkBool(false));
  });

  it("returns null for unknown properties", () => {
    const rv = getPayload(mkRegex(new RegExp("x")));
    expect(getRegexProperty("nonexistent", rv)).toBeNull();
  });
});
