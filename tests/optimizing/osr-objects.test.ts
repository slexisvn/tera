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

const tierUp = (body: string, name = "run") => {
  const source = src(
    body,
    "fn driver(m):",
    "  k = 0",
    "  t = 0",
    "  while k < m:",
    "    t = run(5)",
    "    k = k + 1",
    "  return t",
    "driver(300)",
  );
  const engine = new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
  });
  const optimized = engine.runNative(source);
  const interpreted = withoutJit().runNative(source);
  expect(optimized).toEqual(interpreted);
  return engine.collectFunctions().find((fn) => fn.name === name);
};

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

  it("compiles a prefilled array element read loop through OSR", () => {
    const { optimized, osrCompiled } = differential(src(
      "fn run(n):",
      "  a = [10, 20, 30, 40]",
      "  i = 0",
      "  s = 0",
      "  while i < n:",
      "    s = s + a[i % 4]",
      "    i = i + 1",
      "  return s",
      "run(50000)",
    ));
    expect(optimized).toBe(1250000);
    expect(osrCompiled).toBe(true);
  });

  it("compiles an in-place array update loop through OSR", () => {
    const { optimized, osrCompiled } = differential(src(
      "fn run(n):",
      "  a = [0, 0, 0, 0]",
      "  i = 0",
      "  while i < n:",
      "    a[i % 4] = a[i % 4] + i",
      "    i = i + 1",
      "  return a[0] + a[1] + a[2] + a[3]",
      "run(50000)",
    ));
    expect(optimized).toBe(1249975000);
    expect(osrCompiled).toBe(true);
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

  it("tiers up an object field mutation loop without OSR", () => {
    const fn = tierUp(src(
      "q = {c: 0}",
      "fn run(n):",
      "  i = 0",
      "  while i < n:",
      "    q.c = q.c + i",
      "    i = i + 1",
      "  return q.c",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
  });

  it("tiers up an object field read loop without OSR", () => {
    const fn = tierUp(src(
      "q = {c: 7}",
      "fn run(n):",
      "  i = 0",
      "  s = 0",
      "  while i < n:",
      "    s = s + q.c",
      "    i = i + 1",
      "  return s",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
  });

  it("tiers up an array element read loop without OSR", () => {
    const fn = tierUp(src(
      "b = [10, 20, 30, 40]",
      "fn run(n):",
      "  i = 0",
      "  s = 0",
      "  while i < n:",
      "    s = s + b[i % 4]",
      "    i = i + 1",
      "  return s",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
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
