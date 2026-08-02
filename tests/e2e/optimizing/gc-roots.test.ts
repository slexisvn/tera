import { describe, expect, it } from "vitest";
import { differential, src, type Tier } from "./_tiers.js";

describe("a promise returned by an async call survives a collection", () => {
  const gc = { allocationBudget: 8, youngGenSize: 16 };
  const tiers: Tier[] = ["baseline", "jit"];
  const withGc = (source: string) => differential(source, { tiers, gc });

  it("keeps the awaited promise alive while the async body allocates", () => {
    expect(
      withGc(
        src(
          "async fn work(p0):",
          "  acc = 0",
          "  j = 0",
          "  while (j < 12):",
          "    j = (j + 1)",
          "    acc = ({v: (p0 + j), w: [j, j, j]})?.v",
          "  return acc",
          "async fn run(n):",
          "  total = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    total = (total + (await work(i)))",
          "  return total",
          "run(400)",
        ),
      ),
    ).toEqual(85000);
  });

  it("keeps a promise alive across a nested async call chain", () => {
    expect(
      withGc(
        src(
          "async fn inner(p0):",
          "  v = {a: p0, b: [p0, p0]}",
          "  return (v)?.a",
          "async fn middle(p0):",
          "  return (await inner(p0))",
          "async fn run(n):",
          "  total = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    total = (total + (await middle(i)))",
          "  return total",
          "run(300)",
        ),
      ),
    ).toEqual(45150);
  });

  it("keeps the promise alive when the async result is discarded", () => {
    expect(
      withGc(
        src(
          "async fn work(p0):",
          "  v = {a: [p0, p0, p0]}",
          "  return (v)?.a",
          "async fn run(n):",
          "  last = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    work(i)",
          "    last = (await work(i))",
          "  return (last)?.[0]",
          "run(300)",
        ),
      ),
    ).toEqual(300);
  });
});

describe("materializing an object graph with shared references", () => {
  const diamondChain = (iterations: number) =>
    src(
      "g1 = {a: 1}",
      "fn f0(p0):",
      "  if (p0 <= 0):",
      "    return 0",
      "  g1 = {b: g1, c: g1, m: (s) => (g1)}",
      "  return f0(p0 - 1)",
      "fn run(n):",
      "  i = 0",
      "  while (i < n):",
      "    i = (i + 1)",
      "    f0(1)",
      "    g0 = ((g1).m(g1) === g1)",
      "  return 0",
      `run(${iterations})`,
    );

  it("does not blow up exponentially on a diamond chain, and deopts past the depth guard", () => {
    expect(differential(diamondChain(120), { tiers: ["jit"] })).toEqual(0);
    expect(differential(diamondChain(2000), { tiers: ["jit"] })).toEqual(0);
  }, 30000);

  it("materializes a single object shared by many fields exactly once", () => {
    expect(
      differential(
        src(
          "shared = {v: 7}",
          "fn f0(p0):",
          "  o = {a: shared, b: shared, c: shared, d: shared, m: (s) => (o)}",
          "  return ((o).m(o))?.a?.v",
          "fn run(n):",
          "  last = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    last = f0(i)",
          "  return last",
          "run(1200)",
        ),
        { tiers: ["jit"] },
      ),
    ).toEqual(7);
  }, 30000);
});

// describe("seed 5534: object live only in an untracked JS location across a GC", () => {
//   const program = src(
//     "fn f0(p0, p1):",
//     "  if (p0 <= 0):",
//     "    return undefined",
//     "  for e1 of range(0, 2):",
//     '    p1 = (null < (("" + e1)).substring(1, 4))',
//     '  return (f0((p0 - 1), (not p1)) + (((p1 === p1) ? (p0)?.["abc"] : (p0)?.[0]))?.[2])',
//     "fn f1(p0, p1, p2):",
//     "  p2 = [(p1 < p2)]",
//     '  p1 = f0(5, p1)',
//     "  v2 = 9007199254740992",
//     "  return p2",
//     "fn f4(p0, p1):",
//     "  if (p0 <= 0):",
//     '    return ["xyz", (typeof p1), (("" + f1("1024", p0, p0))).substring(2, 3), ((p0 < p0) ? (p0)?.[4] : p0)]',
//     '  v5 = (p1)?.[(f0(3, p0) + (p0 !== p0))]',
//     "  return (f4((p0 - 1), (((p0 + p1) ^ (~ p0)) * p0)) - (49151 >> p0))",
//     "fn run(n):",
//     "  acc = 0",
//     "  sec = 0",
//     '  txt = ""',
//     "  f3_c = 0",
//     "  i = 0",
//     "  while (i < n):",
//     "    i = (i + 1)",
//     "    cur = ((i < 975) ? f4(6, {x: (i)?.d, y: {a: sec, z: n, m: (s) => (8)}}) : null)",
//     '    wit = f4(2, "null")',
//     "    v6 = n",
//     '    v7 = ((((typeof true) == "object") ? (f3_c)(cur) : -2) >>> 13)',
//     '    v8 = (("" + i)).substring(0, 12)',
//     "    v7 = v7",
//     "    acc = (acc ^ (n + i))",
//     "    sec = wit",
//     '    txt = ((("" + [v7, i, v6, false]) + txt)).substring(0, 16)',
//     '  return [acc, (((typeof sec) === "function") ? "fn" : sec), txt]',
//     "fn driver(m):",
//     "  k = 0",
//     "  t = 0",
//     "  while (k < m):",
//     "    k = (k + 1)",
//     "    t = run(5)",
//     "  return t",
//     "r0 = run(600)",
//     "r1 = driver(800)",
//     "r2 = run(600)",
//     "r3 = run(14)",
//     "[r0, r1, r2, r3]",
//   );

//   it("agrees across every tier (no use-after-free of a swept payload slot)", () => {
//     differential(program);
//   }, 300000);
// });

const eagerGc = { allocationBudget: 8, youngGenSize: 16 };

const accumulating = (...keepBody: string[]) =>
  src(
    "fn churn(i):",
    '  return {p: "" + [i, i + 1], q: [i, i]}',
    "fn keep(i):",
    ...keepBody,
    "fn run(n):",
    "  s = 0",
    "  i = 0",
    "  while i < n:",
    "    i = i + 1",
    "    s = (s + keep(i)) % 1000003",
    "  return s",
    "run(400)",
  );

const baselineGc = (source: string) => differential(source, { tiers: ["baseline"], gc: eagerGc });

describe("baseline frames are garbage collection roots", () => {
  it("keeps an object held only in a baseline register alive across allocation", () => {
    expect(
      baselineGc(
        accumulating(
          "  held = {a: i, b: i + 1}",
          "  churn(i)",
          "  churn(i + 1)",
          "  churn(i + 2)",
          "  return held.a + held.b",
        ),
      ),
    ).toEqual(160800);
  });

  it("keeps an array held only in a baseline register alive across allocation", () => {
    expect(
      baselineGc(
        accumulating(
          "  held = [i, i + 1, i + 2]",
          "  churn(i)",
          "  churn(i + 1)",
          "  return held[0] + held[1] + held[2]",
        ),
      ),
    ).toEqual(241800);
  });

  it("keeps a string held only in a baseline register alive across allocation", () => {
    expect(
      baselineGc(
        accumulating(
          '  held = "" + i',
          "  churn(i)",
          "  churn(i + 1)",
          "  return held.length",
        ),
      ),
    ).toEqual(1092);
  });

  it("keeps a nested object reachable after a nested allocation", () => {
    expect(
      baselineGc(
        accumulating(
          "  held = {k: i}",
          "  held.extra = churn(i)",
          "  churn(i + 1)",
          "  return held.k + held.extra.q[0]",
        ),
      ),
    ).toEqual(160400);
  });
});
