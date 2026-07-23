import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

const src = (...lines: string[]) => lines.join("\n");

const withJit = () => new Engine({ typecheck: "off" });
const withoutJit = () =>
  new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
  });

type OsrEngine = Engine & {
  compileOsr(fn: { name?: string | null }, offset: number): unknown;
};

// Whether an on-stack replacement entry was successfully produced for `name`
// during the run. Tracked via a hook because a loop that later deoptimizes
// (e.g. an accumulator overflowing the smi range) clears its osrCache entry.
const differential = (source: string, name = "run") => {
  const engine = withJit() as OsrEngine;
  let osrCompiled = false;
  const original = engine.compileOsr.bind(engine);
  engine.compileOsr = (fn, offset) => {
    const entry = original(fn, offset);
    if (entry !== null && fn.name === name) osrCompiled = true;
    return entry;
  };
  const optimized = engine.runNative(source);
  const interpreted = withoutJit().runNative(source);
  expect(optimized).toEqual(interpreted);
  return { optimized, engine, osrCompiled };
};

describe("on-stack replacement for object and array loops", () => {
  it("compiles an object field read loop through OSR", () => {
    const { optimized, engine, osrCompiled } = differential(src(
      "fn run(n):",
      "  s = 0",
      "  i = 0",
      "  while i < n:",
      "    p = {x: i, y: i + 1}",
      "    s = s + p.x + p.y",
      "    i = i + 1",
      "  return s",
      "run(50000)",
    ));
    expect(optimized).toBe(2500000000);
    expect(osrCompiled).toBe(true);
    expect(engine.getStats().tracerStats.jit_osr ?? 0).toBeGreaterThan(0);
  });

  it("guards object fields flowing into float arithmetic", () => {
    const { osrCompiled } = differential(src(
      "fn run(n):",
      "  s = 0.0",
      "  i = 0",
      "  while i < n:",
      "    p = {a: i, b: i * i}",
      "    s = s + p.a * 0.5 + p.b",
      "    i = i + 1",
      "  return s",
      "run(50000)",
    ));
    expect(osrCompiled).toBe(true);
  });

  it("compiles an object field mutation loop through OSR", () => {
    const { optimized, osrCompiled } = differential(src(
      "fn run(n):",
      "  p = {c: 0}",
      "  i = 0",
      "  while i < n:",
      "    p.c = p.c + i",
      "    i = i + 1",
      "  return p.c",
      "run(50000)",
    ));
    expect(optimized).toBe(1249975000);
    expect(osrCompiled).toBe(true);
  });

  it("compiles an array push and read loop through OSR", () => {
    const { optimized, osrCompiled } = differential(src(
      "fn run(n):",
      "  a = []",
      "  i = 0",
      "  s = 0",
      "  while i < n:",
      "    a.push(i)",
      "    s = s + a[i]",
      "    i = i + 1",
      "  return s",
      "run(50000)",
    ));
    expect(optimized).toBe(1249975000);
    expect(osrCompiled).toBe(true);
  });

  it("keeps array element read loops correct", () => {
    expect(differential(src(
      "fn run(n):",
      "  a = [10, 20, 30, 40]",
      "  i = 0",
      "  s = 0",
      "  while i < n:",
      "    s = s + a[i % 4]",
      "    i = i + 1",
      "  return s",
      "run(50000)",
    )).optimized).toBe(1250000);
  });

  it("keeps in-place array update loops correct", () => {
    expect(differential(src(
      "fn run(n):",
      "  a = [0, 0, 0, 0]",
      "  i = 0",
      "  while i < n:",
      "    a[i % 4] = a[i % 4] + i",
      "    i = i + 1",
      "  return a[0] + a[1] + a[2] + a[3]",
      "run(50000)",
    )).optimized).toBe(1249975000);
  });

  it("stays correct when a guarded field value grows into a double", () => {
    differential(src(
      "fn run(n):",
      "  s = 0",
      "  i = 0",
      "  while i < n:",
      "    p = {x: i * i}",
      "    s = s + p.x",
      "    i = i + 1",
      "  return s",
      "run(60000)",
    ));
  });

  it("stays correct when a field value becomes a non-number mid-loop", () => {
    expect(differential(src(
      "fn run(n):",
      "  s = 0",
      "  i = 0",
      "  while i < n:",
      "    p = {x: i}",
      "    if i == 30000:",
      "      p.x = \"boom\"",
      "    if i != 30000:",
      "      s = s + p.x",
      "    i = i + 1",
      "  return s",
      "run(50000)",
    )).optimized).toBe(1249945000);
  });
});
