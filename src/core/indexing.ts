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

const COMPLEMENT: ReadonlyMap<string, string> = new Map<string, string>([
  [">", "<="],
  [">=", "<"],
  ["<", ">="],
  ["<=", ">"],
  ["==", "!="],
  ["!=", "=="],
  ["===", "!=="],
  ["!==", "==="],
  ["loose==", "loose!="],
  ["loose!=", "loose=="],
]);

const NO_COUNT = 0;
const ONE_COUNT = 1;

const PROVEN_COUNT: ReadonlyMap<string, (bound: number) => number> = new Map([
  [">", (bound: number) => bound + ONE_COUNT],
  [">=", (bound: number) => bound],
  ["==", (bound: number) => bound],
  ["===", (bound: number) => bound],
  ["loose==", (bound: number) => bound],
  ["!=", (bound: number) => (bound === NO_COUNT ? ONE_COUNT : NO_COUNT)],
  ["!==", (bound: number) => (bound === NO_COUNT ? ONE_COUNT : NO_COUNT)],
  ["loose!=", (bound: number) => (bound === NO_COUNT ? ONE_COUNT : NO_COUNT)],
]);

export function provenCount(op: string, bound: number, negated = false): number {
  const read = negated ? COMPLEMENT.get(op) : op;
  const proven = read === undefined ? NO_COUNT : PROVEN_COUNT.get(read)?.(bound) ?? NO_COUNT;
  return Math.max(NO_COUNT, proven);
}

export const TAKES_ONE_ELEMENT: ReadonlySet<string> = new Set<string>(["pop", "shift"]);
export const ADDS_ONE_ELEMENT: ReadonlySet<string> = new Set<string>(["push", "unshift"]);
