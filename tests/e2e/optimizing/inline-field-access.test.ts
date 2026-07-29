import { describe, expect, it } from "vitest";
import { differential, src, type Tier } from "./_tiers.js";

const jitOsr: Tier[] = ["jit", "osr"];

const driven = (body: string, inner: number, outer = 400) =>
  src(
    body,
    "fn driver(m):",
    "  k = 0",
    "  t = 0",
    "  while (k < m):",
    "    t = run(" + inner + ")",
    "    k = (k + 1)",
    "  return t",
    "driver(" + outer + ")",
  );

describe("inline numeric field store keeps read-modify-write mutation correct", () => {
  it("mutates a local object field in a loop (lowers to inline f64.store)", () => {
    expect(
      differential(
        driven(
          src(
            "fn run(n):",
            "  p = {c: 0}",
            "  i = 0",
            "  while (i < n):",
            "    p.c = (p.c + i)",
            "    i = (i + 1)",
            "  return p.c",
          ),
          50,
        ),
        { tiers: jitOsr },
      ),
    ).toBe(1225);
  });

  it("mutates multiple fields of the same object", () => {
    differential(
      driven(
        src(
          "fn run(n):",
          "  p = {a: 0, b: 1}",
          "  i = 0",
          "  while (i < n):",
          "    p.a = (p.a + p.b)",
          "    p.b = (p.b + i)",
          "    i = (i + 1)",
          "  return (p.a + p.b)",
        ),
        50,
      ),
      { tiers: jitOsr },
    );
  });

  it("does not treat a property-adding (transitioning) store as an inline in-bounds write", () => {
    differential(
      driven(
        src(
          "fn run(n):",
          "  p = {a: 1}",
          "  i = 0",
          "  s = 0",
          "  while (i < n):",
          "    if (i == 3):",
          "      p.b = 7",
          "    s = (s + p.a)",
          "    i = (i + 1)",
          "  return s",
        ),
        50,
      ),
      { tiers: jitOsr },
    );
  });
});

describe("a loop-invariant LOAD_GLOBAL is hoisted only when it is safe", () => {
  it("keeps a global-object field mutation loop correct (invariant global reference)", () => {
    differential(
      driven(
        src(
          "g = {c: 0}",
          "fn run(n):",
          "  i = 0",
          "  while (i < n):",
          "    g.c = (g.c + i)",
          "    i = (i + 1)",
          "  return g.c",
        ),
        60,
      ),
      { tiers: jitOsr },
    );
  });

  it("does not hoist when the global is reassigned in the loop (would read stale)", () => {
    differential(
      driven(
        src(
          "g = 0",
          "fn run(n):",
          "  s = 0",
          "  i = 0",
          "  while (i < n):",
          "    s = (s + g)",
          "    g = (g + 1)",
          "    i = (i + 1)",
          "  return (s + g)",
        ),
        60,
      ),
      { tiers: jitOsr },
    );
  });

  it("stays correct with a call in the loop (hazard, no hoist)", () => {
    differential(
      driven(
        src(
          "g = {c: 0}",
          "fn helper(x):",
          "  return (x + 1)",
          "fn run(n):",
          "  i = 0",
          "  while (i < n):",
          "    g.c = (g.c + helper(i))",
          "    i = (i + 1)",
          "  return g.c",
        ),
        60,
      ),
      { tiers: jitOsr },
    );
  });
});

describe("inline field access on a global object obeys the JS/wasm consistency gates", () => {
  const g = (body: string) => differential(driven(body, 2000), { tiers: ["jit"] });

  it("inlines a global numeric slot mutated and read only numerically", () => {
    expect(
      g(
        src(
          "q = {c: 0}",
          "fn run(n):",
          "  i = 0",
          "  s = 0",
          "  while (i < n):",
          "    q.c = q.c + i",
          "    s = s + q.c",
          "    i = i + 1",
          "  return s",
        ),
      ),
    ).toEqual(1596535333000);
  });

  it("stays correct when the same global slot is also read as a handle (return q.c)", () => {
    g(
      src(
        "q = {c: 0}",
        "fn run(n):",
        "  i = 0",
        "  while (i < n):",
        "    q.c = q.c + i",
        "    i = i + 1",
        "  return q.c",
      ),
    );
  });

  it("stays correct when the mutating function also calls out (callee re-reads JS)", () => {
    g(
      src(
        "q = {c: 0}",
        "fn bump(x):",
        "  return x + 1",
        "fn run(n):",
        "  i = 0",
        "  while (i < n):",
        "    q.c = q.c + bump(i)",
        "    i = i + 1",
        "  return q.c",
      ),
    );
  });

  it("keeps local object numeric mutation correct (unchanged path)", () => {
    expect(
      g(
        src(
          "fn run(n):",
          "  p = {c: 0}",
          "  i = 0",
          "  while (i < n):",
          "    p.c = p.c + i",
          "    i = i + 1",
          "  return p.c",
        ),
      ),
    ).toEqual(1999000);
  });
});

describe("inline allocation grows the wasm heap instead of trapping", () => {
  const chaining = (iterations: number) =>
    src(
      'g0 = [{a: 1}, "null", true]',
      "g2 = 1",
      "fn f0(p0):",
      "  g0 = [{x: g0}, (p0)?.a, {z: g2}]",
      "fn f3(p0, p1, p2):",
      '  ((((typeof (g0)?.push) === "function") and ((g0)?.length < 16)) ? (g0).push("1") : 0)',
      "fn run(n):",
      "  i = 0",
      "  while (i < n):",
      "    i = (i + 1)",
      '    wit = f0("xyz")',
      "    g2 = f3()",
      `run(${iterations})`,
    );

  const escaping = (iterations: number) =>
    src(
      "keep = []",
      "fn f0(i):",
      "  o = {a: i, b: i, c: i}",
      "  keep = [o, keep]",
      "  return (o)?.a",
      "fn run(n):",
      "  s = 0",
      "  i = 0",
      "  while (i < n):",
      "    i = (i + 1)",
      "    s = (s + f0(i))",
      "  return s",
      `run(${iterations})`,
    );

  it("survives a long chain of escaping allocations past a memory page", () => {
    expect(differential(chaining(1200), { tiers: jitOsr })).toEqual(undefined);
    expect(differential(chaining(3000), { tiers: jitOsr })).toEqual(undefined);
  });

  it("keeps escaping object fields exact across the growth boundary", () => {
    expect(differential(escaping(2000), { tiers: jitOsr })).toEqual(2001000);
    expect(differential(escaping(5000), { tiers: jitOsr })).toEqual(12502500);
  }, 120000);
});
