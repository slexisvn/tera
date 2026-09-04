import { describe, expect, it } from "vitest";
import { arrayElementType, arrayOfType } from "../../../src/frontend/checker/type-system.js";

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
