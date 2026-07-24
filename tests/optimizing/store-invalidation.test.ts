import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

const src = (...lines: string[]) => lines.join("\n");

const withoutJit = () =>
  new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
  });

const withJit = () =>
  new Engine({
    typecheck: "off",
    osr: false,
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
  });

type Invalidated = { name?: string | null; dependencyDeoptCount?: number };

const runOptimized = (source: string, name: string) => {
  const engine = withJit();
  const value = engine.runNative(source);
  expect(value).toEqual(withoutJit().runNative(source));
  const fn = engine
    .collectFunctions()
    .find((f) => (f as Invalidated).name === name) as Invalidated | undefined;
  return { value, dependencyDeopts: fn?.dependencyDeoptCount ?? 0 };
};

const mutatingCallee = src(
  "fn bump(o):",
  "  o.k = o.k + 1",
  "  return o.k",
  "fn step(o):",
  "  return bump(o)",
  "fn run(n):",
  "  o = {k: 0}",
  "  i = 0",
  "  w = 0",
  "  while i < n:",
  "    w = step(o)",
  "    i = i + 1",
  "  return o.k",
  "run(2000)",
);

describe("shape-preserving stores keep optimized code alive", () => {
  it("does not invalidate a callee that writes its own speculated field", () => {
    const { value, dependencyDeopts } = runOptimized(mutatingCallee, "bump");
    expect(value).toEqual(2000);
    expect(dependencyDeopts).toBe(0);
  });

  it("does not invalidate on a direct field write loop", () => {
    const { value, dependencyDeopts } = runOptimized(
      src(
        "fn bump(o):",
        "  o.k = o.k + 1",
        "  return o.k",
        "fn run(n):",
        "  o = {k: 0}",
        "  i = 0",
        "  w = 0",
        "  while i < n:",
        "    w = bump(o)",
        "    i = i + 1",
        "  return o.k",
        "run(2000)",
      ),
      "bump",
    );
    expect(value).toEqual(2000);
    expect(dependencyDeopts).toBe(0);
  });

  it("does not invalidate when writing an overflow property", () => {
    const { dependencyDeopts } = runOptimized(
      src(
        "fn bump(o):",
        "  o.h = o.h + 1",
        "  return o.h",
        "fn run(n):",
        "  o = {a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7}",
        "  i = 0",
        "  w = 0",
        "  while i < n:",
        "    w = bump(o)",
        "    i = i + 1",
        "  return o.h",
        "run(2000)",
      ),
      "bump",
    );
    expect(dependencyDeopts).toBe(0);
  });

  it("still deoptimizes when a property is added to the speculated shape", () => {
    expect(
      runOptimized(
        src(
          "fn peek(o):",
          "  return o.k",
          "fn run(n):",
          "  o = {k: 1}",
          "  i = 0",
          "  s = 0",
          "  while i < n:",
          "    s = s + peek(o)",
          "    if i == 1000:",
          "      o.zz = 5",
          "    i = i + 1",
          "  return s",
          "run(2000)",
        ),
        "peek",
      ).value,
    ).toEqual(2000);
  });

  it("still deoptimizes when a property is deleted from the speculated shape", () => {
    expect(
      runOptimized(
        src(
          "fn peek(o):",
          "  return o.k",
          "fn run(n):",
          "  o = {k: 1, j: 2}",
          "  i = 0",
          "  s = 0",
          "  while i < n:",
          "    s = s + peek(o)",
          "    if i == 1000:",
          "      delete o.j",
          "    i = i + 1",
          "  return s",
          "run(2000)",
        ),
        "peek",
      ).value,
    ).toEqual(2000);
  });

  it("keeps a mutated field visible to a separately optimized reader", () => {
    expect(
      runOptimized(
        src(
          "fn bump(o):",
          "  o.k = o.k + 1",
          "  return 0",
          "fn peek(o):",
          "  return o.k",
          "fn run(n):",
          "  o = {k: 0}",
          "  i = 0",
          "  s = 0",
          "  while i < n:",
          "    bump(o)",
          "    s = peek(o)",
          "    i = i + 1",
          "  return s",
          "run(2000)",
        ),
        "peek",
      ).value,
    ).toEqual(2000);
  });
});
