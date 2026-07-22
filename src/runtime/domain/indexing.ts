import { Tensor } from "@slexisvn/mlfw";
import type { TaggedValue } from "../../core/value/index.js";
import type { IndexDim } from "../../core/indexing.js";
import type { JSObject } from "../../objects/heap/js-object.js";

type ToTagged = (value: unknown) => TaggedValue;

type TensorLike = Tensor & {
  slice(dim: number, start: number, end: number, step: number): TensorLike;
  select(dim: number, index: number): TensorLike;
};

function selectAxis(tensor: TensorLike, axis: number, raw: number): TensorLike | number | undefined {
  if (!Number.isInteger(raw)) throw new RangeError("Tensor index must be an integer");
  const size = tensor.shape[axis]!;
  const index = raw < 0 ? raw + size : raw;
  if (index < 0 || index >= size) return undefined;
  const next = tensor.select(axis, index);
  return next.ndim === 0 ? next.item() : next;
}

function indexTensor(tensor: TensorLike, dims: readonly IndexDim[]): TensorLike | number {
  let value: TensorLike = tensor;
  let axis = 0;
  for (const dim of dims) {
    if (axis >= value.ndim) throw new RangeError(`Too many indices for tensor with ${value.ndim} dimensions`);
    if (dim.kind === "slice") {
      const start = dim.start ?? 0;
      const end = dim.stop ?? value.shape[axis]!;
      const step = dim.step;
      if (![start, end, step].every(Number.isInteger)) throw new RangeError("Slice bounds must be integers");
      if (step <= 0) throw new RangeError("Slice step must be a positive integer");
      value = value.slice(axis, start, end, step);
      axis++;
    } else {
      const selected = selectAxis(value, axis, dim.value);
      if (selected === undefined) {
        throw new RangeError(`Index ${dim.value} is out of bounds for dimension ${axis} with size ${value.shape[axis]}`);
      }
      if (typeof selected === "number") return selected;
      value = selected;
    }
  }
  return value;
}

export function installHostIndexing(object: JSObject, value: unknown, toTagged: ToTagged): void {
  if (!(value instanceof Tensor)) return;
  const tensor = value as TensorLike;
  object._index = (index) => {
    const selected = selectAxis(tensor, 0, index);
    return selected === undefined ? undefined : toTagged(selected);
  };
  object._indexND = (dims) => toTagged(indexTensor(tensor, dims));
}
