import {
  getPayload,
  isArray,
  isObject,
  isString,
  mkArray,
  mkString,
  mkUndefined,
  type TaggedValue,
} from "../core/value/index.js";
import { normalizeIndex, resolveSlice, type IndexDim } from "../core/indexing.js";
import { createJSArray } from "../objects/heap/factory.js";
import { VMTypeError } from "../core/errors/index.js";

export type NativeIndexer = (dims: readonly IndexDim[]) => TaggedValue;

function indexArray(value: TaggedValue, dims: readonly IndexDim[]): TaggedValue {
  let current = value;
  for (const dim of dims) {
    if (!isArray(current)) throw new VMTypeError("Too many indices for array");
    const arr = getPayload(current);
    const length = arr.getLength();
    if (dim.kind === "slice") {
      const { start, stop, step } = resolveSlice(dim, length);
      const out: Array<TaggedValue | undefined> = [];
      for (let i = Math.max(0, start); i < Math.min(length, stop); i += step) out.push(arr.getIndex(i));
      current = mkArray(createJSArray(out));
    } else {
      const index = normalizeIndex(dim.value, length);
      if (index < 0 || index >= length) {
        throw new RangeError(`Index ${dim.value} is out of bounds for array of length ${length}`);
      }
      current = arr.getIndex(index) ?? mkUndefined();
    }
  }
  return current;
}

function indexString(value: TaggedValue, dims: readonly IndexDim[]): TaggedValue {
  let current = value;
  for (const dim of dims) {
    if (!isString(current)) throw new VMTypeError("Too many indices for string");
    const text = getPayload(current);
    const length = text.length;
    if (dim.kind === "slice") {
      const { start, stop, step } = resolveSlice(dim, length);
      let out = "";
      for (let i = Math.max(0, start); i < Math.min(length, stop); i += step) out += text[i];
      current = mkString(out);
    } else {
      const index = normalizeIndex(dim.value, length);
      if (index < 0 || index >= length) {
        throw new RangeError(`Index ${dim.value} is out of bounds for string of length ${length}`);
      }
      current = mkString(text[index]!);
    }
  }
  return current;
}

export function indexValue(obj: TaggedValue, dims: readonly IndexDim[]): TaggedValue {
  if (isArray(obj)) return indexArray(obj, dims);
  if (isString(obj)) return indexString(obj, dims);
  if (isObject(obj)) {
    const indexer = getPayload(obj)._indexND;
    if (indexer) return indexer(dims);
  }
  throw new VMTypeError("Indexing expects a Tensor, array, or string");
}
