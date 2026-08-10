import { describe, expect, it } from "vitest";
import { differential, src, type Tier } from "../../helpers/tiers.js";

const jitOsr: Tier[] = ["jit", "osr"];

describe("deoptimization does not fabricate values for handle-typed nodes", () => {
  it("resumes a guarded method call without inventing a numeric callee", () => {
    expect(
      differential(
        src(
          "g0 = ({a: 1})?.d",
          "fn f0(p0, p1):",
          "  if (p0 <= 0):",
          "    return {d: 1, z: 2}",
          "  g0 = p0",
          '  return (f0((p0 - 1), ({c: 1, a: (g0)?.b})?.z) * (((typeof (g0)?.m) === "function") ? (g0).m(g0) : ((p1)?.d - (p0 ^ p0))))',
          "fn run(n):",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    cur = f0(6, 0)",
          "  return cur",
          "run(1200)",
        ),
        { tiers: jitOsr },
      ),
    ).toEqual(NaN);
  });

  it("keeps a mirrored global correct across a deopt resume", () => {
    expect(
      differential(
        src(
          "g0 = 0",
          "fn f0(p0):",
          "  g0 = p0",
          '  return (((typeof (g0)?.push) === "function") ? (g0).push(1) : (g0 + 1))',
          "fn run(n):",
          "  last = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    last = f0(i)",
          "  return last",
          "run(1200)",
        ),
        { tiers: jitOsr },
      ),
    ).toEqual(1201);
  });

  it("keeps an optional call on a changing global consistent", () => {
    expect(
      differential(
        src(
          'g0 = "abc"',
          "fn f0(p0):",
          "  if ((p0 % 2) == 0):",
          "    g0 = p0",
          "  else:",
          '    g0 = "abc"',
          '  return (((typeof (g0)?.substring) === "function") ? (g0)?.substring(0, 2) : (g0 + 1))',
          "fn run(n):",
          "  last = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    last = f0(i)",
          "  return last",
          "run(1200)",
        ),
        { tiers: jitOsr },
      ),
    ).toEqual(1201);
  });
});

describe("deopt from a no-frameState stub resumes at entry, not a stale offset", () => {
  it("does not throw when a failing return stub coincides with a dead optional chain", () => {
    expect(
      differential(
        src(
          "g0 = 0",
          "g1 = null",
          "fn f0(p0):",
          "  (g1)?.a",
          "  return g0",
          "fn run(n):",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    cur = f0()",
          "    g0 = {z: g0}",
          "r0 = run(3000)",
          "[r0]",
        ),
      ),
    ).toEqual([undefined]);
  }, 30000);

  it("still short-circuits the optional chain to undefined when its result is used", () => {
    expect(
      differential(
        src(
          "g0 = 0",
          "g1 = null",
          "fn f0(p0):",
          "  return (g1)?.a",
          "fn run(n):",
          "  cur = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    cur = f0()",
          "    g0 = {z: g0}",
          "  return cur",
          "r0 = run(3000)",
          "[r0]",
        ),
      ),
    ).toEqual([undefined]);
  }, 30000);
});

describe("deoptimization materializes loop-carried phis from runtime values", () => {
  it("resumes with the current loop accumulator after a late type miss", () => {
    expect(
      differential(
        src(
          "fn run(n, poison):",
          "  i = 0",
          "  acc = 0",
          "  while i < n:",
          "    v = 1",
          "    if i == poison:",
          '      v = "x"',
          "    acc = acc + v",
          "    i = i + 1",
          "  return acc",
          "fn driver(m):",
          "  k = 0",
          "  r = 0",
          "  while k < m:",
          "    r = run(5, -1)",
          "    k = k + 1",
          "  return r",
          "warm = driver(300)",
          "probe = run(4, 2)",
          "[warm, probe]",
        ),
        { tiers: jitOsr },
      ),
    ).toEqual([5, "2x1"]);
  });
});
