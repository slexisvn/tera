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

const driven = (...body: string[]) =>
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
  driven(
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
        driven(
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
