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

const withOsr = () =>
  new Engine({
    typecheck: "off",
    tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 },
  });

const differential = (source: string) => {
  const expected = withoutJit().runNative(source);
  expect(withJit().runNative(source)).toEqual(expected);
  expect(withOsr().runNative(source)).toEqual(expected);
  return expected;
};

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
