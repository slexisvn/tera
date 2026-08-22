import { describe, expect, it } from "vitest";
import {
  isUntypedName,
  isUnwrittenType,
  splitTopLevel,
} from "../../src/core/type-text.js";

describe("splitTopLevel", () => {
  it("splits a plain list", () => {
    expect(splitTopLevel("int, string", ",")).toEqual(["int", " string"]);
  });

  it("keeps a nested generic together", () => {
    expect(splitTopLevel("Map<string, int>, bool", ",")).toEqual(["Map<string, int>", " bool"]);
  });

  it("keeps a parenthesised function type together", () => {
    expect(splitTopLevel("(int, int) -> int, bool", ",")).toEqual([
      "(int, int) -> int",
      " bool",
    ]);
  });

  it("does not close a nesting level on the arrow of a function type", () => {
    expect(splitTopLevel("(int) -> int | null", "|")).toEqual(["(int) -> int ", " null"]);
  });

  it("keeps a bracketed tuple together", () => {
    expect(splitTopLevel("[int, int], string", ",")).toEqual(["[int, int]", " string"]);
  });

  it("ignores a separator inside a quoted literal type", () => {
    expect(splitTopLevel('"a,b" | int', "|")).toEqual(['"a,b" ', " int"]);
  });

  it("returns the whole source when the separator never appears", () => {
    expect(splitTopLevel("int", ",")).toEqual(["int"]);
  });
});

describe("isUnwrittenType", () => {
  it("treats a missing type as unwritten", () => {
    expect(isUnwrittenType(undefined)).toBe(true);
    expect(isUnwrittenType(null)).toBe(true);
  });

  it("treats the catch-all type as unwritten", () => {
    expect(isUnwrittenType("any")).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isUnwrittenType("  any  ")).toBe(true);
  });

  it("treats a named type as written", () => {
    expect(isUnwrittenType("int")).toBe(false);
  });

  it("treats the other placeholder names as written", () => {
    expect(isUnwrittenType("unknown")).toBe(false);
    expect(isUnwrittenType("void")).toBe(false);
  });
});

describe("isUntypedName", () => {
  it("covers every name that stands for no runtime shape", () => {
    for (const name of ["any", "unknown", "undefined", "void", "never"]) {
      expect(isUntypedName(name)).toBe(true);
    }
  });

  it("treats a missing name as untyped", () => {
    expect(isUntypedName(undefined)).toBe(true);
    expect(isUntypedName(null)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isUntypedName(" never ")).toBe(true);
  });

  it("treats a named type as typed", () => {
    expect(isUntypedName("int")).toBe(false);
    expect(isUntypedName("(int) -> int")).toBe(false);
  });

  it("is wider than the unwritten check", () => {
    expect(isUntypedName("void")).toBe(true);
    expect(isUnwrittenType("void")).toBe(false);
  });
});
