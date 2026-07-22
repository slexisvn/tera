import { describe, it, expect } from "vitest";
import * as mlfw from "@slexisvn/mlfw";
import { installHostIndexing } from "../../../src/runtime/domain/indexing.js";
import { createJSObject } from "../../../src/objects/heap/factory.js";
import type { IndexDim } from "../../../src/core/indexing.js";

const tensor = (mlfw as Record<string, unknown>).tensor as (...args: unknown[]) => unknown;
const arange = (mlfw as Record<string, unknown>).arange as (...args: unknown[]) => unknown;

const at = (value: number): IndexDim => ({ kind: "index", value });
const span = (start: number | null, stop: number | null, step = 1): IndexDim => ({ kind: "slice", start, stop, step });

function hooked(value: unknown) {
  const object = createJSObject();
  installHostIndexing(object, value, (native) => native as never);
  return object;
}

const matrix = () => tensor([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]);
const elements = (result: unknown) => (result as { toArray(): unknown }).toArray();

describe("installHostIndexing", () => {
  it("installs no hooks for a non-tensor value", () => {
    const object = hooked({ not: "a tensor" });
    expect(object._index).toBeUndefined();
    expect(object._indexND).toBeUndefined();
  });

  it("installs both hooks for a tensor", () => {
    const object = hooked(matrix());
    expect(typeof object._index).toBe("function");
    expect(typeof object._indexND).toBe("function");
  });

  describe("_index", () => {
    it("selects along the first axis", () => {
      expect(elements(hooked(matrix())._index!(0))).toEqual([1, 2, 3]);
      expect(elements(hooked(matrix())._index!(1))).toEqual([4, 5, 6]);
    });

    it("counts a negative index from the end", () => {
      expect(elements(hooked(matrix())._index!(-1))).toEqual([4, 5, 6]);
    });

    it("unwraps a rank-0 result to a plain number", () => {
      expect(hooked(arange(0, 6))._index!(2)).toBe(2);
      expect(hooked(arange(0, 6))._index!(-1)).toBe(5);
    });

    it("returns undefined out of bounds so the caller can fall through", () => {
      expect(hooked(matrix())._index!(9)).toBeUndefined();
      expect(hooked(matrix())._index!(-9)).toBeUndefined();
    });

    it("rejects a non-integer index", () => {
      expect(() => hooked(matrix())._index!(1.5)).toThrow("Tensor index must be an integer");
    });
  });

  describe("_indexND", () => {
    it("selects a row with a single index dimension", () => {
      expect(elements(hooked(matrix())._indexND!([at(0)]))).toEqual([1, 2, 3]);
    });

    it("returns a scalar when every axis is indexed", () => {
      expect(hooked(matrix())._indexND!([at(1), at(2)])).toBe(6);
    });

    it("takes a column by slicing then indexing", () => {
      expect(elements(hooked(matrix())._indexND!([span(null, null), at(0)]))).toEqual([1, 4]);
    });

    it("mixes an index and a slice", () => {
      expect(elements(hooked(matrix())._indexND!([at(1), span(1, 3)]))).toEqual([5, 6]);
    });

    it("slices with a step", () => {
      expect(elements(hooked(arange(0, 6))._indexND!([span(null, null, 2)]))).toEqual([0, 2, 4]);
    });

    it("normalizes a negative index dimension", () => {
      expect(elements(hooked(matrix())._indexND!([at(-1)]))).toEqual([4, 5, 6]);
    });

    it("returns the scalar as soon as every axis collapses, ignoring extra dimensions", () => {
      expect(hooked(matrix())._indexND!([at(0), at(0), at(0)])).toBe(1);
    });

    it("rejects more dimensions than the tensor has when none collapse to a scalar", () => {
      expect(() => hooked(matrix())._indexND!([span(0, 2), span(0, 2), span(0, 2)])).toThrow(
        "Too many indices for tensor with 2 dimensions",
      );
    });

    it("rejects an out-of-bounds index dimension", () => {
      expect(() => hooked(matrix())._indexND!([at(7)])).toThrow(
        "Index 7 is out of bounds for dimension 0 with size 2",
      );
    });

    it("rejects a non-integer slice bound", () => {
      expect(() => hooked(matrix())._indexND!([span(0.5, 2)])).toThrow("Slice bounds must be integers");
    });

    it("rejects a non-positive slice step", () => {
      expect(() => hooked(matrix())._indexND!([span(0, 2, 0)])).toThrow(
        "Slice step must be a positive integer",
      );
    });
  });
});
