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

const observed = (body: string, observation: string) =>
  src(
    "fn f0(p0):",
    `  return ${body}`,
    "fn run(n):",
    "  last = 0",
    "  i = 0",
    "  while i < n:",
    "    i = i + 1",
    `    last = ${observation}`,
    "  return last",
    "run(1200)",
  );

const concatenated = (body: string) => observed(body, '"" + f0(1)');

describe("block parameter representation", () => {
  it("keeps a boolean returned out of a logical operator a boolean", () => {
    for (const [body, expected] of [
      ["true and true", "true"],
      ["true or false", "true"],
      ["false or true", "true"],
      ["true and false", "false"],
      ["(p0 == 1) and true", "true"],
      ["p0 and true", "true"],
    ] as const) {
      expect(differential(concatenated(body))).toEqual(expected);
    }
  });

  it("reports the boolean type of a logical operator result", () => {
    expect(differential(observed("true and true", "typeof f0(1)"))).toEqual("boolean");
    expect(differential(observed("false or true", "typeof f0(1)"))).toEqual("boolean");
  });

  it("keeps a logical operator result strictly equal to a boolean", () => {
    expect(differential(observed("true and true", "f0(1) === true"))).toEqual(true);
    expect(differential(observed("true and false", "f0(1) === false"))).toEqual(true);
  });

  it("keeps a boolean mixed with a non-boolean operand a boolean", () => {
    for (const body of ['"a" and true', "1 and true", "0 or true", '"" or true', "null or true"]) {
      expect(differential(concatenated(body))).toEqual("true");
    }
  });

  it("keeps a number flowing out of a logical operator away from the handle table", () => {
    for (const value of [1, 1023, 1024, 1025, 2048, 49151, 49152, 49153]) {
      expect(differential(concatenated(`${value} or "a"`))).toEqual(String(value));
      expect(differential(concatenated(`${value} or null`))).toEqual(String(value));
    }
  });

  it("keeps the non-boolean branch of a logical operator intact", () => {
    for (const [body, expected] of [
      ['true and "a"', "a"],
      ["true and 1", "1"],
      ['"a" or 1', "a"],
      ['"" or "b"', "b"],
      ["0 or 1.5", "1.5"],
    ] as const) {
      expect(differential(concatenated(body))).toEqual(expected);
    }
  });

  it("keeps a boolean merged across an if/else a boolean", () => {
    expect(
      differential(
        src(
          "fn f0(p0):",
          "  if p0 % 2 == 0:",
          "    w = true",
          "  else:",
          "    w = false",
          "  return w",
          "fn run(n):",
          '  last = 0',
          "  i = 0",
          "  while i < n:",
          "    i = i + 1",
          '    last = "" + f0(i)',
          "  return last",
          "run(1200)",
        ),
      ),
    ).toEqual("true");
  });
});
