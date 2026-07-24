import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

const src = (...lines: string[]) => lines.join("\n");

const withoutJit = () =>
  new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
  });

const driver = src(
  "fn driver(m):",
  "  k = 0",
  "  t = 0",
  "  while k < m:",
  "    t = run(5)",
  "    k = k + 1",
  "  return t",
  "driver(300)",
);

const tierUp = (body: string, name = "run") => {
  const source = src(body, driver);
  const engine = new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
  });
  const optimized = engine.runNative(source);
  expect(optimized).toEqual(withoutJit().runNative(source));
  return engine.collectFunctions().find((fn) => fn.name === name);
};

const withOsr = () =>
  new Engine({
    typecheck: "off",
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
  });

const differential = (source: string) => {
  const expected = withoutJit().runNative(source);
  const optimized = new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
  }).runNative(source);
  expect(optimized).toEqual(expected);
  expect(withOsr().runNative(source)).toEqual(expected);
  return expected;
};

describe("object literal allocation in optimized code", () => {
  it("keeps a single-property literal optimized", () => {
    const fn = tierUp(src(
      "fn run(n):",
      "  p = {c: 0}",
      "  i = 0",
      "  while i < n:",
      "    p.c = p.c + i",
      "    i = i + 1",
      "  return p.c",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.deoptCount ?? 0).toBe(0);
  });

  it("keeps a multi-property literal optimized", () => {
    const fn = tierUp(src(
      "fn run(n):",
      "  p = {x: 1, y: 2}",
      "  i = 0",
      "  while i < n:",
      "    p.x = p.x + i",
      "    i = i + 1",
      "  return p.x + p.y",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.deoptCount ?? 0).toBe(0);
  });

  it("keeps a literal with computed initializers optimized", () => {
    const fn = tierUp(src(
      "fn run(n):",
      "  p = {x: n, y: n * 2}",
      "  return p.x + p.y",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.deoptCount ?? 0).toBe(0);
  });

  it("keeps non-numeric literal fields intact", () => {
    expect(differential(src(
      "fn run(n):",
      "  p = {s: \"hi\", v: n}",
      "  return p.v + p.s",
      driver,
    ))).toBe("5hi");
  });

  it("stays correct when a literal field is later assigned a string", () => {
    expect(differential(src(
      "fn run(n):",
      "  p = {x: n, y: 2}",
      "  p.y = \"s\"",
      "  return p.x + p.y",
      driver,
    ))).toBe("5s");
  });

  it("stays correct when initialization deoptimizes between stores", () => {
    expect(differential(src(
      "fn run(n):",
      "  p = {a: n, b: n * n * n}",
      "  return p.a + p.b",
      driver,
      "run(2000000)",
    ))).toBe(8000000000002000000);
  });

  it("stays correct when a literal is reallocated after a deoptimization", () => {
    expect(differential(src(
      "fn run(n):",
      "  p = {a: n, b: n + 1}",
      "  return p.a + p.b",
      driver,
      "a = run(2000000000)",
      "b = run(7)",
      "a + b",
    ))).toBe(4000000016);
  });

  it("keeps separate literals in one function distinct", () => {
    const fn = tierUp(src(
      "fn run(n):",
      "  p = {a: n}",
      "  q = {b: n + 1}",
      "  return p.a + q.b",
    ));
    expect(fn?.optimizedCode).toBeTruthy();
    expect(fn?.deoptCount ?? 0).toBe(0);
  });
});
