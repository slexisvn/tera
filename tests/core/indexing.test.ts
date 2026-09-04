import { describe, it, expect } from "vitest";
import { countProvesSome, normalizeIndex, resolveSlice } from "../../src/core/indexing.js";

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

  describe("countProvesSome", () => {
    it("proves some from a count above any bound at or over zero", () => {
      expect(countProvesSome(">", 0)).toBe(true);
      expect(countProvesSome(">", 3)).toBe(true);
      expect(countProvesSome(">", -1)).toBe(false);
    });

    it("proves some from a count at or over one", () => {
      expect(countProvesSome(">=", 1)).toBe(true);
      expect(countProvesSome(">=", 0)).toBe(false);
    });

    it("proves some from a count that equals a bound of at least one", () => {
      expect(countProvesSome("==", 1)).toBe(true);
      expect(countProvesSome("==", 3)).toBe(true);
      expect(countProvesSome("loose==", 1)).toBe(true);
      expect(countProvesSome("===", 2)).toBe(true);
      expect(countProvesSome("==", 0)).toBe(false);
    });

    it("proves some only from a count that differs from zero", () => {
      expect(countProvesSome("!=", 0)).toBe(true);
      expect(countProvesSome("loose!=", 0)).toBe(true);
      expect(countProvesSome("!=", 1)).toBe(false);
    });

    it("reads a negated test as its complement", () => {
      expect(countProvesSome("!=", 1, true)).toBe(true);
      expect(countProvesSome("loose!=", 2, true)).toBe(true);
      expect(countProvesSome("<", 1, true)).toBe(true);
      expect(countProvesSome("<=", 0, true)).toBe(true);
      expect(countProvesSome("==", 0, true)).toBe(true);
    });

    it("proves nothing from a negated test that leaves the count at zero", () => {
      expect(countProvesSome("!=", 0, true)).toBe(false);
      expect(countProvesSome("loose!=", 0, true)).toBe(false);
      expect(countProvesSome(">", 0, true)).toBe(false);
      expect(countProvesSome(">=", 1, true)).toBe(false);
    });

    it("proves nothing from an operator it does not know", () => {
      expect(countProvesSome("in", 1)).toBe(false);
      expect(countProvesSome("<", 1)).toBe(false);
      expect(countProvesSome("in", 1, true)).toBe(false);
    });
  });
});
