import { describe, it, expect } from "vitest";
import { indexValue } from "../../src/runtime/indexing.js";
import type { IndexDim } from "../../src/core/indexing.js";
import { JSArray } from "../../src/objects/heap/js-array.js";
import { createJSObject } from "../../src/objects/heap/factory.js";
import {
  getPayload,
  isArray,
  mkArray,
  mkObject,
  mkSmi,
  mkString,
  type TaggedValue,
} from "../../src/core/value/index.js";

const at = (value: number): IndexDim => ({ kind: "index", value });
const span = (start: number | null, stop: number | null, step = 1): IndexDim => ({ kind: "slice", start, stop, step });

const array = (...values: number[]) => mkArray(new JSArray(values.map(mkSmi)));
const nested = (...rows: number[][]) => mkArray(new JSArray(rows.map((row) => array(...row))));

const numbers = (value: TaggedValue): number[] =>
  getPayload(value as never).elements.map((el: TaggedValue) => getPayload(el as never) as number);

describe("indexValue", () => {
  describe("arrays", () => {
    it("reads a single element", () => {
      expect(getPayload(indexValue(array(10, 20, 30), [at(1)]) as never)).toBe(20);
    });

    it("counts a negative index from the end", () => {
      expect(getPayload(indexValue(array(10, 20, 30), [at(-1)]) as never)).toBe(30);
    });

    it("slices a range", () => {
      expect(numbers(indexValue(array(10, 20, 30, 40), [span(1, 3)]))).toEqual([20, 30]);
    });

    it("slices with a step", () => {
      expect(numbers(indexValue(array(0, 1, 2, 3, 4, 5), [span(null, null, 2)]))).toEqual([0, 2, 4]);
    });

    it("slices from a negative start to the end", () => {
      expect(numbers(indexValue(array(10, 20, 30, 40), [span(-2, null)]))).toEqual([30, 40]);
    });

    it("clamps a slice that runs past the end", () => {
      expect(numbers(indexValue(array(10, 20), [span(0, 99)]))).toEqual([10, 20]);
    });

    it("yields an empty array when the range is inverted", () => {
      expect(numbers(indexValue(array(10, 20, 30), [span(2, 1)]))).toEqual([]);
    });

    it("descends dimensions left to right", () => {
      expect(getPayload(indexValue(nested([1, 2, 3], [4, 5, 6]), [at(1), at(2)]) as never)).toBe(6);
    });

    it("applies a slice then an index to the sliced result", () => {
      const result = indexValue(nested([1, 2], [3, 4], [5, 6]), [span(1, null), at(0)]);
      expect(numbers(result)).toEqual([3, 4]);
    });

    it("returns a fresh array rather than aliasing the source", () => {
      const source = array(1, 2, 3);
      const sliced = indexValue(source, [span(0, 3)]);
      expect(isArray(sliced)).toBe(true);
      expect(getPayload(sliced as never)).not.toBe(getPayload(source as never));
    });

    it("rejects an out-of-bounds index", () => {
      expect(() => indexValue(array(1, 2), [at(5)])).toThrow("out of bounds for array of length 2");
      expect(() => indexValue(array(1, 2), [at(-3)])).toThrow("out of bounds for array of length 2");
    });

    it("rejects more indices than dimensions", () => {
      expect(() => indexValue(array(1, 2), [at(0), at(0)])).toThrow("Too many indices for array");
    });
  });

  describe("strings", () => {
    it("reads a single character", () => {
      expect(getPayload(indexValue(mkString("hello"), [at(1)]) as never)).toBe("e");
    });

    it("counts a negative index from the end", () => {
      expect(getPayload(indexValue(mkString("hello"), [at(-1)]) as never)).toBe("o");
    });

    it("slices a substring", () => {
      expect(getPayload(indexValue(mkString("hello world"), [span(0, 5)]) as never)).toBe("hello");
    });

    it("slices from a negative start", () => {
      expect(getPayload(indexValue(mkString("hello world"), [span(-5, null)]) as never)).toBe("world");
    });

    it("slices with a step", () => {
      expect(getPayload(indexValue(mkString("hello world"), [span(null, null, 2)]) as never)).toBe("hlowrd");
    });

    it("rejects an out-of-bounds index", () => {
      expect(() => indexValue(mkString("ab"), [at(7)])).toThrow("out of bounds for string of length 2");
    });

    it("keeps descending because a single character is still a string", () => {
      expect(getPayload(indexValue(mkString("ab"), [at(0), at(0)]) as never)).toBe("a");
    });

    it("rejects an index past the end of a character reached by descending", () => {
      expect(() => indexValue(mkString("ab"), [at(0), at(1)])).toThrow("out of bounds for string of length 1");
    });
  });

  describe("host objects", () => {
    it("delegates to the _indexND hook and forwards the dimensions", () => {
      const seen: IndexDim[][] = [];
      const object = createJSObject();
      object._indexND = (dims) => {
        seen.push([...dims]);
        return mkString("from-hook");
      };

      const dims = [at(1), span(0, 2, 1)];
      expect(getPayload(indexValue(mkObject(object), dims) as never)).toBe("from-hook");
      expect(seen).toEqual([dims]);
    });

    it("rejects an object without an indexing hook", () => {
      expect(() => indexValue(mkObject(createJSObject()), [at(0)])).toThrow(
        "Indexing expects a Tensor, array, or string",
      );
    });
  });

  it("rejects a value that cannot be indexed", () => {
    expect(() => indexValue(mkSmi(5), [at(0)])).toThrow("Indexing expects a Tensor, array, or string");
  });
});
