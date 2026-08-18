import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/index.js";
import { snakeToCamel } from "../../../src/utils/naming.js";

const run = (source: string) => new Engine().runValue(source).value;

const asJs = (expression: string) =>
  expression.replace(
    /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g,
    (_, name: string) => `${snakeToCamel(name)}(`,
  );

const hostResult = (receiver: string, expression: string) =>
  new Function(`return (${receiver}).${asJs(expression)};`)();

const CASES: readonly (readonly [string, string, string])[] = [
  ["a fractional slice start", "[10, 20, 30, 40]", 'slice(1.5, 3).join(",")'],
  ["a fractional slice end", "[10, 20, 30, 40]", 'slice(1, 2.9).join(",")'],
  ["a negative fractional slice start", "[10, 20, 30, 40]", 'slice(-2.5).join(",")'],
  ["a string slice bound", "[10, 20, 30, 40]", 'slice("2").join(",")'],
  ["a slice bound beyond the smi range", "[10, 20, 30, 40]", 'slice(2000000000).join(",")'],
  ["a fractional splice start", "[10, 20, 30, 40]", 'splice(1.5, 2).join(",")'],
  ["a fractional splice count", "[10, 20, 30, 40]", 'splice(1, 1.9).join(",")'],
  ["string splice bounds", "[10, 20, 30, 40]", 'splice("1", "2").join(",")'],
  ["a fractional index_of start", "[10, 20, 30, 20]", "index_of(20, 2.5)"],
  ["a string index_of start", "[10, 20, 30, 20]", 'index_of(20, "2")'],
  ["an includes start beyond the smi range", "[10, 20, 30, 40]", "includes(30, 2000000000)"],
  ["fractional to_fixed digits", "3.14159", "to_fixed(2.7)"],
  ["string to_fixed digits", "3.14159", 'to_fixed("3")'],
  ["fractional to_precision digits", "3.14159", "to_precision(3.9)"],
  ["string to_precision digits", "3.14159", 'to_precision("4")'],
  ["fractional to_exponential digits", "3.14159", "to_exponential(2.8)"],
  ["string to_exponential digits", "3.14159", 'to_exponential("3")'],
];

describe("intrinsic integer arguments agree with the host", () => {
  for (const [name, receiver, expression] of CASES) {
    it(`coerces ${name}`, () => {
      expect(run(`a = ${receiver}\na.${expression}`)).toBe(
        hostResult(receiver, expression),
      );
    });
  }

  it("coerces a loop variable used as a bound", () => {
    const expected = [0, 1, 2, 3]
      .map((i) => [10, 20, 30, 40].slice(i / 2).join("|"))
      .join(",");

    expect(
      run(
        [
          "parts = []",
          "for i of range(0, 4):",
          '  parts.push([10, 20, 30, 40].slice(i / 2).join("|"))',
          'parts.join(",")',
        ].join("\n"),
      ),
    ).toBe(expected);
  });

  it("coerces a loop variable used as digit count", () => {
    const expected = [0, 1, 2, 3].map((i) => (3.14159).toFixed(i / 2)).join(",");

    expect(
      run(
        [
          "parts = []",
          "for i of range(0, 4):",
          "  parts.push((3.14159).to_fixed(i / 2))",
          'parts.join(",")',
        ].join("\n"),
      ),
    ).toBe(expected);
  });
});
