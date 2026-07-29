export type IndexDim =
  | { kind: "index"; value: number }
  | { kind: "slice"; start: number | null; stop: number | null; step: number };

export type SliceBounds = { start: number; stop: number; step: number };

export function resolveSlice(
  dim: { start: number | null; stop: number | null; step: number },
  length: number,
): SliceBounds {
  let start = dim.start ?? 0;
  let stop = dim.stop ?? length;
  const step = dim.step;
  if (!Number.isInteger(start) || !Number.isInteger(stop) || !Number.isInteger(step)) {
    throw new RangeError("Slice bounds must be integers");
  }
  if (step <= 0) throw new RangeError("Slice step must be a positive integer");
  if (start < 0) start += length;
  if (stop < 0) stop += length;
  return { start, stop, step };
}

export function normalizeIndex(value: number, length: number): number {
  if (!Number.isInteger(value)) throw new RangeError("Index must be an integer");
  return value < 0 ? value + length : value;
}
