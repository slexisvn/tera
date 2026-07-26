import { describe, expect, it } from "vitest";
import { differential, src, tierUp } from "./_tiers.js";

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

const compiled = (body: string) => tierUp(src(body, driver), "run");

describe("marshalling-dominated object code stays in baseline", () => {
  it("declines a loop that mutates a global object and calls a heap-passing helper (seed 655 shape)", () => {
    const fn = compiled(
      src(
        "g = {c: 0}",
        "fn make(x):",
        "  j = 0",
        "  a = [0, 0]",
        "  while j < 2:",
        "    a[j] = x + j",
        "    j = j + 1",
        "  return a",
        "fn run(n):",
        "  i = 0",
        "  while i < n:",
        "    g.c = g.c + i",
        "    v = make(i)",
        "    g.c = g.c + v[0]",
        "    i = i + 1",
        "  return g.c",
      ),
    );
    expect(fn?.optimizedCode ?? null).toBeFalsy();
    expect(fn?.lastCompileFailureReason ?? "").toContain("marshalling-dominated");
  });

  it("declines a loopless leaf that allocates and returns a heap value (seed 1391 shape)", () => {
    const fn = tierUp(
      src("fn run(n):", "  a = [n, n + 1]", "  return [a[n % 2], a]", driver),
      "run",
    );
    expect(fn?.optimizedCode ?? null).toBeFalsy();
    expect(fn?.lastCompileFailureReason ?? "").toContain("per-call marshalling-dominated");
  });
});

describe("escaping allocation stored to a global stays in baseline", () => {
  it("declines a function that stores a fresh object into a global each iteration", () => {
    const fn = compiled(
      src(
        "g = {v: 0}",
        "fn run(n):",
        "  i = 0",
        "  while i < n:",
        "    g = {v: i}",
        "    i = i + 1",
        "  return g.v",
      ),
    );
    expect(fn?.optimizedCode ?? null).toBeFalsy();
  });
});

describe("self-recursive function returning a heap value stays in baseline (seed 233)", () => {
  const program = src(
    "g0 = 0.5",
    "g2 = [1]",
    "fn f0(p0, p1):",
    "  if (p0 <= 0):",
    "    return {b: g0, z: (~ p0), d: (true ? g2 : g2)}",
    "  v1 = [(p1)?.d]",
    "  return (f0((p0 - 1), ((g0 & g0) >>> 14)) + p0)",
    "fn run(n):",
    "  acc = 0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    '    acc = (acc + (f0(5, "ab") + i))',
    "  return acc",
    "fn driver(m):",
    "  k = 0",
    "  t = 0",
    "  while (k < m):",
    "    k = (k + 1)",
    "    t = run(12)",
    "  return t",
    "r0 = run(1200)",
    "r1 = driver(800)",
    "[r0, r1]",
  );

  it("agrees with the oracle across every tier and declines to optimize f0", () => {
    differential(program);
    const f0 = tierUp(program, "f0");
    expect(f0?.optimizedCode ?? null).toBeFalsy();
  });
});

describe("functions that should still tier up are not over-declined", () => {
  it("JITs a global-object mutation loop with no calls (LICM keeps it fast)", () => {
    const fn = compiled(
      src(
        "q = {c: 0}",
        "fn run(n):",
        "  i = 0",
        "  while i < n:",
        "    q.c = q.c + i",
        "    i = i + 1",
        "  return q.c",
      ),
    );
    expect(fn?.optimizedCode).toBeTruthy();
  });

  it("JITs a local object mutation loop (no global, no call)", () => {
    const fn = compiled(
      src(
        "fn run(n):",
        "  p = {c: 0}",
        "  i = 0",
        "  while i < n:",
        "    p.c = p.c + i",
        "    i = i + 1",
        "  return p.c",
      ),
    );
    expect(fn?.optimizedCode).toBeTruthy();
  });

  it("JITs a loopless function that only returns strings (no alloc, no dynamic access)", () => {
    const fn = compiled(
      src("fn run(n):", "  if n % 2 == 0:", '    return "even"', '  return "odd"'),
    );
    expect(fn?.optimizedCode).toBeTruthy();
  });
});
