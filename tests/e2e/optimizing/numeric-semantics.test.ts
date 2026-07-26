import { describe, expect, it } from "vitest";
import { differential, src, oracle as withoutJit, type Tier } from "./_tiers.js";

const hotBody = (...body: string[]) =>
  src(
    ...body,
    "fn run(n):",
    "  last = 0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    "    last = f0(i)",
    "  return last",
    "run(1200)",
  );

describe("negative zero survives every tier", () => {
  const neg = (expr: string) =>
    Object.is(differential(hotBody("fn f0(p0):", `  return ${expr}`)), -0);

  it("keeps -0 from sign-opposite multiply, negative remainder, division, power", () => {
    expect(neg("(0 * (0 - 3))")).toBe(true);
    expect(neg("((0 - 5) * 0)")).toBe(true);
    expect(neg("((0 - 7) % 7)")).toBe(true);
    expect(neg("(0 / (0 - 3))")).toBe(true);
    expect(neg("((0 * (0 - 1)) ** 1)")).toBe(true);
  });

  it("keeps +0 where the sign must not flip", () => {
    expect(neg("(0 * 3)")).toBe(false);
    expect(neg("(7 % 7)")).toBe(false);
    expect(neg("((0 - 3) * (0 - 3))")).toBe(false);
  });

  it("keeps -0 from a generic multiply whose operand is not a number", () => {
    expect(neg("(null * (0 - 3))")).toBe(true);
    expect(neg('("" * (0 - 3))')).toBe(true);
  });

  it("accumulates -0 across a loop that alternates the sign", () => {
    const acc = (iterations: number) =>
      Object.is(
        differential(
          src(
            "fn run(n):",
            "  acc = 0",
            "  i = 0",
            "  while (i < n):",
            "    i = (i + 1)",
            "    acc = (acc * (0 - 3))",
            "  return acc",
            `run(${iterations})`,
          ),
        ),
        -0,
      );
    expect(acc(1201)).toBe(true);
    expect(acc(1200)).toBe(false);
  });
});

describe("integer arithmetic is folded to the exact value, not wrapped to int32", () => {
  const exact = (expr: string) =>
    differential(hotBody("fn f0(p0):", `  return ${expr}`));

  it("does not wrap a constant product past 2**31", () => {
    expect(exact("(65536 * 65536)")).toEqual(4294967296);
    expect(exact("(2147483647 * 2)")).toEqual(4294967294);
  });

  it("keeps a runtime product exact past the int32 range", () => {
    expect(
      differential(
        hotBody("fn f0(p0):", "  v0 = (p0 + 99999)", "  return (v0 * v0)"),
      ),
    ).toEqual(101199 * 101199);
  });
});

describe("ToInt32 of doubles outside the int64 range", () => {
  const t: Tier[] = ["jit", "osr"];
  const constant = (expr: string) =>
    differential(hotBody("fn f0(p0):", `  return ${expr}`), { tiers: t });
  const derived = (expr: string) =>
    differential(hotBody("fn f0(p0):", "  v0 = (p0 * 1e19)", `  return ${expr}`), {
      tiers: t,
    });

  it("reduces a magnitude beyond 2**63 modulo 2**32 instead of saturating", () => {
    expect(constant("(1e308 | 0)")).toEqual(0);
    expect(constant("(1e308 >>> 0)")).toEqual(0);
    expect(constant("(1e308 << 1)")).toEqual(0);
    expect(constant("(~ 1e308)")).toEqual(-1);
  });

  it("keeps the low 32 bits of a magnitude between 2**63 and 2**85", () => {
    expect(constant("(1e21 | 0)")).toEqual(-559939584);
    expect(constant("(-1e21 | 0)")).toEqual(559939584);
    expect(constant("(1e21 >>> 0)")).toEqual(3735027712);
    expect(constant("(~ 1e21)")).toEqual(559939583);
  });

  it("agrees across the 2**63 guard boundary", () => {
    expect(constant("(9223372036854774784 | 0)")).toEqual(-1024);
    expect(constant("(9223372036854775808 | 0)")).toEqual(0);
    expect(constant("(-9223372036854775808 | 0)")).toEqual(0);
  });

  it("keeps magnitudes inside the int64 range exact", () => {
    expect(constant("(~ 2147483648)")).toEqual(2147483647);
    expect(constant("(3000000000 | 0)")).toEqual(-1294967296);
    expect(constant("(-2147483649 | 0)")).toEqual(2147483647);
    expect(constant("(~ p0)")).toEqual(-1201);
  });

  it("keeps the non-finite inputs at zero", () => {
    expect(constant("(Infinity | 0)")).toEqual(0);
    expect(constant("((-Infinity) | 0)")).toEqual(0);
    expect(constant("(NaN | 0)")).toEqual(0);
  });

  it("reduces a value computed at runtime rather than a literal", () => {
    expect(derived("(v0 | 0)")).toEqual(1870659584);
    expect(derived("(v0 >> 3)")).toEqual(233832448);
    expect(derived("((0 - v0) | 0)")).toEqual(-1870659584);
  });
});

describe("strict equality on references in compiled code", () => {
  const hot = (...body: string[]) =>
    differential(
      src(
        ...body,
        "fn driver(m):",
        "  k = 0",
        "  t = 0",
        "  while (k < m):",
        "    k = (k + 1)",
        "    t = run(8)",
        "  return t",
        "driver(800)",
      ),
      { tiers: ["baseline", "jit"] },
    );

  it("treats a reference as equal to itself and distinct references as unequal", () => {
    expect(
      hot(
        "fn run(n):",
        "  v = {z: 31}",
        "  w = {z: 31}",
        "  a = [1, 2]",
        "  return [(v === v), (a === a), (run === run), (v === w), (v !== w)]",
      ),
    ).toEqual([true, true, true, false, true]);
  });

  it("keeps null and undefined strictly distinct", () => {
    expect(
      hot(
        "fn run(n):",
        "  return [(null === undefined), (null === null), (undefined === undefined)]",
      ),
    ).toEqual([false, true, true]);
  });

  it("keeps a reassigned global equal to itself", () => {
    expect(
      hot("g0 = {a: 1}", "fn run(n):", "  g0 = {z: 31}", "  return (g0 === g0)"),
    ).toEqual(true);
  });

  it("keeps primitive strict equality unchanged", () => {
    expect(
      hot(
        "fn run(n):",
        '  return [(1 === 1), (1 === 2), ("a" === "a"), (true === true), (1 === 1.0)]',
      ),
    ).toEqual([true, false, true, true, true]);
  });
});

describe("a definition merged from a branch that never assigns it is undefined", () => {
  const t: Tier[] = ["jit", "osr"];
  const branch = (taken: boolean, assignment: string) =>
    differential(
      hotBody(
        `g0 = ${taken}`,
        "fn f0(p0):",
        "  if g0:",
        `    v2 = ${assignment}`,
        "  return v2",
      ),
      { tiers: t },
    );

  it("yields undefined when the untaken value is arithmetic, non-numeric, or constant", () => {
    for (const rhs of ["(p0 + 3)", "(p0 ** 65)", '"x"', "true", "null", "[1]", "5", "(p0 | 3)"]) {
      expect(branch(false, rhs)).toEqual(undefined);
    }
  });

  it("still observes the value when the branch is taken", () => {
    expect(branch(true, "(p0 + 3)")).toEqual(1203);
    expect(branch(true, "(p0 | 3)")).toEqual(1203);
    expect(branch(true, '"x"')).toEqual("x");
    expect(branch(true, "5")).toEqual(5);
  });
});

const selfFeeding = (body: string) =>
  src(
    "fn f0(a, i):",
    `  return ${body}`,
    "fn run(n):",
    "  acc = 1",
    "  i = 0",
    "  while i < n:",
    "    acc = f0(acc, i)",
    "    i = i + 1",
    "  return acc",
    "run(3000)",
  );

const forwarded = (f0body: string, f1body: string) =>
  src(
    "fn f0(a, i):",
    `  return ${f0body}`,
    "fn f1(a, i):",
    "  t = f0(a, i)",
    `  return ${f1body}`,
    "fn run(n):",
    "  acc = 0",
    "  i = 0",
    "  while i < n:",
    "    acc = f1(acc, i)",
    "    i = i + 1",
    "  return acc",
    "run(3000)",
  );

describe("int32 speculation overflows to double", () => {
  it("promotes a self-feeding multiply past the int32 range", () => {
    for (const body of ["(a * 2)", "(a * 3)", "(a * 4)", "(a * 5)", "(a * 6)", "(a * 7)"]) {
      expect(differential(selfFeeding(body))).toEqual(Infinity);
    }
  });

  it("promotes a self-feeding add past the int32 range", () => {
    for (const body of ["(a + a)", "((a + a) + 1)", "((a * 2) + 1)"]) {
      expect(differential(selfFeeding(body))).toEqual(Infinity);
    }
  });

  it("promotes when the overflowing value crosses a call boundary", () => {
    for (const [f1body, expected] of [
      ["(t + 1)", Infinity],
      ["(t * 1)", Infinity],
      ["(t + t)", Infinity],
      ["(t - 1)", 0],
    ] as const) {
      expect(differential(forwarded("((a * 2) + 1)", f1body))).toEqual(expected);
    }
  });

  it("promotes when the callee never multiplies", () => {
    expect(differential(forwarded("((a + a) + 1)", "(t + 1)"))).toEqual(Infinity);
  });

  it("promotes through a three-deep call chain", () => {
    expect(
      differential(
        src(
          "fn f0(a, i):",
          "  return ((a * 2) + 1)",
          "fn f1(a, i):",
          "  t = f0(a, i)",
          "  return (t + 1)",
          "fn f2(a, i):",
          "  t = f1(a, i)",
          "  return (t + 1)",
          "fn run(n):",
          "  acc = 0",
          "  i = 0",
          "  while i < n:",
          "    acc = f2(acc, i)",
          "    i = i + 1",
          "  return acc",
          "run(3000)",
        ),
      ),
    ).toEqual(Infinity);
  });

  it("keeps a negative overflow negative", () => {
    expect(differential(selfFeeding("(a * 0 - 2)"))).toEqual(
      withoutJit().runNative(selfFeeding("(a * 0 - 2)")),
    );
  });

  it("keeps exact values just inside the int32 range", () => {
    expect(
      differential(
        src(
          "fn f(a):",
          "  return a + 1",
          "fn run(n):",
          "  i = 0",
          "  w = 0",
          "  while i < n:",
          "    w = f(1)",
          "    i = i + 1",
          "  return f(2147483646)",
          "run(2000)",
        ),
      ),
    ).toEqual(2147483647);
  });

  it("promotes a value one past the int32 range", () => {
    expect(
      differential(
        src(
          "fn f(a):",
          "  return a + 1",
          "fn run(n):",
          "  i = 0",
          "  w = 0",
          "  while i < n:",
          "    w = f(1)",
          "    i = i + 1",
          "  return f(2147483647)",
          "run(2000)",
        ),
      ),
    ).toEqual(2147483648);
  });

  it("keeps fractional results exact across a call boundary", () => {
    expect(
      differential(
        src(
          "fn f0(a, i):",
          "  return a + 0.5",
          "fn f1(a, i):",
          "  t = f0(a, i)",
          "  return t + 1",
          "fn run(n):",
          "  i = 0",
          "  last = 0",
          "  while i < n:",
          "    last = f1(i, i)",
          "    i = i + 1",
          "  return last",
          "run(2000)",
        ),
      ),
    ).toEqual(2000.5);
  });

  it("still folds a bitwise shift with wraparound semantics", () => {
    expect(
      differential(
        src(
          "fn f(a):",
          "  return (a * 2) | 0",
          "fn run(n):",
          "  i = 0",
          "  w = 0",
          "  while i < n:",
          "    w = f(1)",
          "    i = i + 1",
          "  return f(2147483647)",
          "run(2000)",
        ),
      ),
    ).toEqual(-2);
  });
});

const stepReturning = (...body: string[]) =>
  src(
    ...body,
    "fn run(n):",
    "  last = 0",
    "  i = 0",
    "  while i < n:",
    "    i = i + 1",
    "    last = f0(4)",
    "  return last",
    "run(1200)",
  );

const returning = (value: string, operator: string, operand: string) =>
  stepReturning(
    "fn f0(p0):",
    "  if p0 <= 0:",
    `    return ${value}`,
    `  return f0(p0 - 1) ${operator} ${operand}`,
  );

describe("arithmetic on a known call result", () => {
  it("keeps a recursive null base case out of the arithmetic", () => {
    expect(differential(returning("null", "*", "16"))).toEqual(0);
    expect(differential(returning("null", "+", "16"))).toEqual(64);
    expect(differential(returning("null", "-", "16"))).toEqual(-64);
  });

  it("keeps a recursive undefined base case producing NaN", () => {
    expect(differential(returning("undefined", "*", "16"))).toEqual(NaN);
  });

  it("keeps a recursive string base case following string semantics", () => {
    expect(differential(returning('"7"', "*", "2"))).toEqual(112);
    expect(differential(returning('"a"', "+", '"b"'))).toEqual("abbbb");
  });

  it("keeps a recursive object base case producing NaN", () => {
    expect(differential(returning("{a: 1}", "*", "16"))).toEqual(NaN);
  });

  it("keeps a non-recursive call returning a non-number out of the arithmetic", () => {
    expect(
      differential(
        stepReturning(
          "fn base(p0):",
          "  return null",
          "fn f0(p0):",
          "  return base(p0) * 16",
        ),
      ),
    ).toEqual(0);
  });

  it("keeps a numeric recursive base case exact", () => {
    expect(differential(returning("1", "*", "16"))).toEqual(65536);
    expect(differential(returning("3", "+", "2"))).toEqual(11);
    expect(differential(returning("0.5", "*", "2"))).toEqual(8);
  });
});
