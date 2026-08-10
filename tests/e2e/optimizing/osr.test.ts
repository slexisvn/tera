import { describe, expect, it } from "vitest";
import type { Engine } from "../../../src/index.js";
import { differential, oracle, production, src } from "../../helpers/tiers.js";

type CompiledLike = { name?: string | null; osrCache?: Map<number, unknown> };

function osrCompiled(engine: Engine, name: string): boolean {
  const fns = engine.collectFunctions() as unknown as CompiledLike[];
  const fn = fns.find((f) => f.name === name);
  if (!fn?.osrCache) return false;
  for (const entry of fn.osrCache.values()) if (entry !== null) return true;
  return false;
}

const againstOracle = (source: string) => differential(source, { tiers: ["production"] });

describe("on-stack replacement", () => {
  it("compiles and enters a hot loop on a single call", () => {
    const source = src(
      "fn hot(n):",
      "  acc = 0",
      "  i = 0",
      "  while i < n:",
      "    acc = (acc + i * 3 + (i % 7)) % 1000000007",
      "    i += 1",
      "  return acc",
      "hot(50000)",
    );
    const engine = production();

    expect(engine.runNative(source)).toEqual(oracle().runNative(source));
    expect(osrCompiled(engine, "hot")).toBe(true);
    expect(engine.getStats().tracerStats.jit_osr ?? 0).toBeGreaterThan(0);
  });

  it("preserves semantics for float loops", () => {
    againstOracle(src(
      "fn f(n):",
      "  x = 1.0",
      "  i = 0",
      "  while i < n:",
      "    x = x * 0.9999 + 0.5",
      "    i += 1",
      "  return x",
      "f(50000)",
    ));
  });

  it("preserves global side effects performed inside the loop", () => {
    expect(againstOracle(src(
      "total = 0",
      "fn run(n):",
      "  i = 0",
      "  while i < n:",
      "    total = total + i",
      "    i += 1",
      "  return total",
      "run(50000)",
    ))).toBe(1249975000);
  });

  it("runs post-loop code and returns through the optimized entry", () => {
    againstOracle(src(
      "fn run(n):",
      "  acc = 0",
      "  i = 0",
      "  while i < n:",
      "    acc = (acc + i) % 999983",
      "    i += 1",
      "  return acc * 2 + 7",
      "run(50000)",
    ));
  });

  it("deoptimizes correctly when an int loop value overflows to double", () => {
    againstOracle(src(
      "fn run(n):",
      "  s = 0",
      "  i = 0",
      "  while i < n:",
      "    s = s + i",
      "    i += 1",
      "  return s",
      "run(100000)",
    ));
  });

  it("handles branches, nested loops, calls, and early returns", () => {
    againstOracle(src(
      "fn run(n):",
      "  s = 0",
      "  i = 0",
      "  while i < n:",
      "    if i % 2 == 0:",
      "      s = s + i",
      "    else:",
      "      s = s - 1",
      "    i += 1",
      "  return s",
      "run(50000)",
    ));
    againstOracle(src(
      "fn run(n):",
      "  s = 0",
      "  i = 0",
      "  while i < n:",
      "    j = 0",
      "    while j < 5:",
      "      s = (s + i * j) % 1000000007",
      "      j += 1",
      "    i += 1",
      "  return s",
      "run(20000)",
    ));
    againstOracle(src(
      "fn step(a, b):",
      "  return (a + b) % 1000003",
      "fn run(n):",
      "  acc = 0",
      "  i = 0",
      "  while i < n:",
      "    acc = step(acc, i)",
      "    i += 1",
      "  return acc",
      "run(50000)",
    ));
    againstOracle(src(
      "fn run(n):",
      "  i = 0",
      "  while i < n:",
      "    if i * i > 900000000:",
      "      return i",
      "    i += 1",
      "  return -1",
      "run(50000)",
    ));
  });

  it("does not disturb loops that never reach the OSR budget", () => {
    const engine = production();
    const value = engine.runNative(src(
      "fn small(n):",
      "  acc = 0",
      "  i = 0",
      "  while i < n:",
      "    acc = acc + i",
      "    i += 1",
      "  return acc",
      "small(100)",
    ));
    expect(value).toBe(4950);
    expect(osrCompiled(engine, "small")).toBe(false);
  });
});
