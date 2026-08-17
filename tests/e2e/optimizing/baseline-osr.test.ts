import { describe, expect, it } from "vitest";
import type { Engine } from "../../../src/index.js";
import { nodeEngine } from "../../helpers/engine.js";
import { differential, oracle, src } from "../../helpers/tiers.js";

type CompiledLike = {
  name?: string | null;
  osrCache?: Map<number, unknown>;
  baselineCode?: unknown;
  optimizedCode?: unknown;
};

const BASELINE_THRESHOLD = 2;
const WARMUP_CALLS = 3;
const WARMUP_ITERATIONS = 4;
const HOT_ITERATIONS = 150000;

const trappedInBaseline = (osr: boolean) =>
  nodeEngine({
    typecheck: "off",
    osr,
    tieringPolicy: {
      baselineThreshold: BASELINE_THRESHOLD,
      jitThreshold: Number.MAX_SAFE_INTEGER,
    },
  });

const compiledFunction = (engine: Engine, name: string) =>
  (engine.collectFunctions() as unknown as CompiledLike[]).find(
    (fn) => fn.name === name,
  );

const osrEntered = (fn: CompiledLike | undefined) => {
  if (!fn?.osrCache) return false;
  for (const entry of fn.osrCache.values()) if (entry !== null) return true;
  return false;
};

const coldThenHot = (body: string[], hotIterations = HOT_ITERATIONS) =>
  src(
    "fn work(n):",
    ...body,
    "warm = 0",
    `for k of range(${WARMUP_CALLS}):`,
    `  warm = warm + work(${WARMUP_ITERATIONS})`,
    `work(${hotIterations})`,
  );

const COUNTING_LOOP = [
  "  seen = 0",
  "  i = 0",
  "  while i < n:",
  "    seen = seen + 1",
  "    i = i + 1",
  "  return seen * 2 + 1",
];

describe("on-stack replacement out of baseline-compiled code", () => {
  it("tiers a hot loop up to optimized code after the function is already in baseline", () => {
    const source = coldThenHot(COUNTING_LOOP);
    const engine = trappedInBaseline(true);

    expect(engine.runNative(source)).toEqual(oracle().runNative(source));

    const work = compiledFunction(engine, "work");
    expect(work?.baselineCode).toBeTruthy();
    expect(work?.optimizedCode).toBeFalsy();
    expect(osrEntered(work)).toBe(true);
  }, 60000);

  it("leaves the loop in baseline when OSR is disabled", () => {
    const source = coldThenHot(COUNTING_LOOP);
    const engine = trappedInBaseline(false);

    expect(engine.runNative(source)).toEqual(oracle().runNative(source));

    const work = compiledFunction(engine, "work");
    expect(work?.baselineCode).toBeTruthy();
    expect(osrEntered(work)).toBe(false);
  }, 60000);

  it("keeps the accumulated loop state when the baseline frame is replaced mid-loop", () => {
    expect(
      differential(coldThenHot(COUNTING_LOOP), { tiers: ["baselineOsr"] }),
    ).toBe(HOT_ITERATIONS * 2 + 1);
  }, 60000);

  it("carries a smi accumulator that overflows to double through the replacement", () => {
    differential(
      coldThenHot([
        "  s = 0",
        "  i = 0",
        "  while i < n:",
        "    s = s + i",
        "    i = i + 1",
        "  return s",
      ]),
      { tiers: ["baselineOsr"] },
    );
  }, 60000);

  it("replaces a conditional back edge and honours an early return", () => {
    differential(
      coldThenHot([
        "  i = 0",
        "  while true:",
        "    if i >= n:",
        "      return -1",
        "    if i * i > 900000000:",
        "      return i",
        "    i = i + 1",
      ]),
      { tiers: ["baselineOsr"] },
    );
  }, 60000);

  it("replaces an outer loop that carries a nested loop and a call", () => {
    differential(
      src(
        "fn step(a, b):",
        "  return (a + b) % 1000003",
        "fn work(n):",
        "  acc = 0",
        "  i = 0",
        "  while i < n:",
        "    j = 0",
        "    while j < 3:",
        "      acc = step(acc, i * j)",
        "      j = j + 1",
        "    i = i + 1",
        "  return acc",
        "warm = 0",
        `for k of range(${WARMUP_CALLS}):`,
        `  warm = warm + work(${WARMUP_ITERATIONS})`,
        "work(40000)",
      ),
      { tiers: ["baselineOsr"] },
    );
  }, 60000);

  it("preserves global side effects written by the loop it replaces", () => {
    const hotIterations = 50000;
    const triangular = (n: number) => ((n - 1) * n) / 2;
    expect(
      differential(
        src(
          "total = 0",
          "fn work(n):",
          "  i = 0",
          "  while i < n:",
          "    total = total + i",
          "    i = i + 1",
          "  return total",
          "warm = 0",
          `for k of range(${WARMUP_CALLS}):`,
          `  warm = warm + work(${WARMUP_ITERATIONS})`,
          `work(${hotIterations})`,
        ),
        { tiers: ["baselineOsr"] },
      ),
    ).toBe(WARMUP_CALLS * triangular(WARMUP_ITERATIONS) + triangular(hotIterations));
  }, 60000);
});
