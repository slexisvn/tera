import { describe, expect, it } from "vitest";
import { typeAccepts } from "../../src/frontend/checker/index.js";

describe("typeAccepts", () => {
  it("accepts a type in its own position", () => {
    expect(typeAccepts("int", "int")).toBe(true);
    expect(typeAccepts("string", "string")).toBe(true);
  });

  it("accepts a widening but not the narrowing back", () => {
    expect(typeAccepts("int", "float")).toBe(true);
    expect(typeAccepts("float", "int")).toBe(false);
  });

  it("accepts a member of a union but not the union in a member's place", () => {
    expect(typeAccepts("int", "int | string")).toBe(true);
    expect(typeAccepts("int | string", "int")).toBe(false);
  });

  it("accepts a value where null is also allowed, but not the reverse", () => {
    expect(typeAccepts("int", "int | null")).toBe(true);
    expect(typeAccepts("int | null", "int")).toBe(false);
  });

  it("rejects unrelated named types and accepts a name for itself", () => {
    expect(typeAccepts("Shape", "Shape")).toBe(true);
    expect(typeAccepts("Shape", "Circle")).toBe(false);
  });

  it("compares list element types", () => {
    expect(typeAccepts("int[]", "int[]")).toBe(true);
    expect(typeAccepts("int[]", "string[]")).toBe(false);
  });
});
