import { describe, expect, it } from "vitest";
import { arrayElementType, arrayOfType, compatible, type TypeEnv } from "../../../src/frontend/checker/type-system.js";

describe("arrayOfType", () => {
  it("suffixes a name that already reads as one element", () => {
    expect(arrayOfType("int")).toBe("int[]");
    expect(arrayOfType("Point")).toBe("Point[]");
  });

  it("suffixes an element that is itself an array", () => {
    expect(arrayOfType("int[]")).toBe("int[][]");
  });

  it("parenthesises a union so the suffix binds to the whole of it", () => {
    expect(arrayOfType("int | null")).toBe("(int | null)[]");
    expect(arrayOfType("string | undefined")).toBe("(string | undefined)[]");
  });

  it("parenthesises a tuple and a function type the same way", () => {
    expect(arrayOfType("[int, string]")).toBe("([int, string])[]");
    expect(arrayOfType("(int) => int")).toBe("((int) => int)[]");
  });

  it("names an array whose element the reader can still recover", () => {
    for (const element of ["int", "int[]", "int | null", "string | undefined"]) {
      expect(arrayElementType(arrayOfType(element))).toBe(element);
    }
  });

  it("keeps a compound element out of the bare Array name, which forgets it", () => {
    const named = arrayOfType("int | null");

    expect(named).not.toBe("Array");
    expect(arrayElementType(named)).not.toBeNull();
  });
});

describe("compatible", () => {
  const env = (): TypeEnv => ({
    aliases: new Map(),
    interfaces: new Map(),
    nominalFamilies: new Map(),
    modelForwards: new Map(),
    abstractClasses: new Set(),
  });

  it("reads a union as a set, so the order its members were written in does not matter", () => {
    for (const actual of ["null | Node", "Node | null"]) {
      for (const expected of ["null | Node", "Node | null"]) {
        expect(compatible(actual, expected, env())).toBe(true);
      }
    }
  });

  it("accepts a union whose every member the target admits, however the target is spelled", () => {
    expect(compatible("int | string", "string | int | null", env())).toBe(true);
    expect(compatible("int | string", "null | int | string", env())).toBe(true);
  });

  it("still refuses a union carrying a member the target has no place for", () => {
    expect(compatible("int | string", "int | null", env())).toBe(false);
    expect(compatible("null | Node", "Node", env())).toBe(false);
  });

  it("keeps one member assignable into a union that lists it", () => {
    expect(compatible("Node", "Node | null", env())).toBe(true);
    expect(compatible("null", "Node | null", env())).toBe(true);
  });
});
