import { describe, it, expect } from "vitest";
import { normalizeIndex, provenCount, resolveSlice } from "../../src/core/indexing.js";

const slice = (start: number | null, stop: number | null, step = 1) => ({ start, stop, step });

describe("core indexing", () => {
  describe("resolveSlice", () => {
    it("defaults an absent start to 0 and an absent stop to the length", () => {
      expect(resolveSlice(slice(null, null), 5)).toEqual({ start: 0, stop: 5, step: 1 });
    });

    it("keeps explicit in-range bounds", () => {
      expect(resolveSlice(slice(1, 4), 5)).toEqual({ start: 1, stop: 4, step: 1 });
    });

    it("counts a negative start from the end", () => {
      expect(resolveSlice(slice(-2, null), 5)).toEqual({ start: 3, stop: 5, step: 1 });
    });

    it("counts a negative stop from the end", () => {
      expect(resolveSlice(slice(null, -1), 5)).toEqual({ start: 0, stop: 4, step: 1 });
    });

    it("normalizes both bounds independently", () => {
      expect(resolveSlice(slice(-4, -2), 6)).toEqual({ start: 2, stop: 4, step: 1 });
    });

    it("carries the step through unchanged", () => {
      expect(resolveSlice(slice(null, null, 2), 6)).toEqual({ start: 0, stop: 6, step: 2 });
    });

    it("leaves a negative bound negative when it underflows the length", () => {
      expect(resolveSlice(slice(-9, null), 3)).toEqual({ start: -6, stop: 3, step: 1 });
    });

    it("rejects a non-integer bound", () => {
      expect(() => resolveSlice(slice(0.5, 3), 5)).toThrow("Slice bounds must be integers");
      expect(() => resolveSlice(slice(0, 2.5), 5)).toThrow("Slice bounds must be integers");
      expect(() => resolveSlice(slice(0, 3, 1.5), 5)).toThrow("Slice bounds must be integers");
    });

    it("rejects a zero or negative step", () => {
      expect(() => resolveSlice(slice(0, 3, 0), 5)).toThrow("Slice step must be a positive integer");
      expect(() => resolveSlice(slice(0, 3, -1), 5)).toThrow("Slice step must be a positive integer");
    });
  });

  describe("normalizeIndex", () => {
    it("leaves a non-negative index alone", () => {
      expect(normalizeIndex(0, 4)).toBe(0);
      expect(normalizeIndex(3, 4)).toBe(3);
    });

    it("counts a negative index from the end", () => {
      expect(normalizeIndex(-1, 4)).toBe(3);
      expect(normalizeIndex(-4, 4)).toBe(0);
    });

    it("returns an out-of-range result rather than clamping", () => {
      expect(normalizeIndex(-5, 4)).toBe(-1);
      expect(normalizeIndex(9, 4)).toBe(9);
    });

    it("rejects a non-integer index", () => {
      expect(() => normalizeIndex(1.5, 4)).toThrow("Index must be an integer");
      expect(() => normalizeIndex(Number.NaN, 4)).toThrow("Index must be an integer");
    });
  });

  describe("provenCount", () => {
    it("counts one more than a bound the count must exceed", () => {
      expect(provenCount(">", 0)).toBe(1);
      expect(provenCount(">", 3)).toBe(4);
      expect(provenCount(">", -1)).toBe(0);
    });

    it("counts the bound itself when the count may equal it", () => {
      expect(provenCount(">=", 1)).toBe(1);
      expect(provenCount(">=", 4)).toBe(4);
      expect(provenCount(">=", 0)).toBe(0);
    });

    it("counts the bound a count is equal to", () => {
      expect(provenCount("==", 1)).toBe(1);
      expect(provenCount("==", 3)).toBe(3);
      expect(provenCount("loose==", 2)).toBe(2);
      expect(provenCount("===", 2)).toBe(2);
      expect(provenCount("==", 0)).toBe(0);
    });

    it("counts one only from a count that differs from zero", () => {
      expect(provenCount("!=", 0)).toBe(1);
      expect(provenCount("loose!=", 0)).toBe(1);
      expect(provenCount("!=", 1)).toBe(0);
    });

    it("reads a negated test as its complement", () => {
      expect(provenCount("!=", 1, true)).toBe(1);
      expect(provenCount("loose!=", 2, true)).toBe(2);
      expect(provenCount("<", 1, true)).toBe(1);
      expect(provenCount("<=", 3, true)).toBe(4);
      expect(provenCount("==", 0, true)).toBe(1);
    });

    it("counts nothing from a negated test that leaves the count at zero", () => {
      expect(provenCount("!=", 0, true)).toBe(0);
      expect(provenCount("loose!=", 0, true)).toBe(0);
      expect(provenCount(">", 0, true)).toBe(0);
      expect(provenCount(">=", 1, true)).toBe(0);
    });

    it("counts nothing from an operator it does not know", () => {
      expect(provenCount("in", 1)).toBe(0);
      expect(provenCount("<", 1)).toBe(0);
      expect(provenCount("in", 1, true)).toBe(0);
    });
  });
});
