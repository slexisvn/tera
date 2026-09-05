import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { float, POWER_STEPS } from "../../../src/optimizing/prelude/spelling.js";
import { NodeType, type ASTNode } from "../../../src/frontend/ast/index.js";

const VALUES = [0, 1, 2, -3, 0.5, -0.125, 1e21, 2 ** 512, 2 ** -1074, Number.MAX_VALUE];

function assigned(text: string): ASTNode {
  const program = parse(`v = ${text}${String.fromCharCode(10)}`) as ASTNode;
  const statement = (program.body as readonly ASTNode[])[0]!;
  return (statement.expression as ASTNode).value as ASTNode;
}

function spelledValue(text: string): number {
  const value = assigned(text);
  if (value.type === NodeType.UnaryExpression) {
    return -Number((value.argument as ASTNode).value);
  }
  return Number(value.value);
}

describe("spelling a double as tera source", () => {
  it("gives a whole number a fraction so the source reads it as a float", () => {
    expect(float(2)).toBe("2.0");
    expect(float(-3)).toBe("-3.0");
    expect(float(0)).toBe("0.0");
  });

  it("leaves a number that already spells a fraction alone", () => {
    expect(float(0.5)).toBe("0.5");
    expect(float(-0.125)).toBe("-0.125");
  });

  it("drops the sign JavaScript writes into a positive exponent", () => {
    expect(String(1e21)).toBe("1e+21");
    expect(float(1e21)).toBe("1e21");
    expect(float(2 ** -1074)).toBe("5e-324");
  });

  it("spells every value back into the same double", () => {
    for (const value of VALUES) {
      expect(spelledValue(float(value))).toBe(value);
    }
  });

  it("spells a positive value the parser reads as one literal", () => {
    for (const value of VALUES.filter((one) => one >= 0)) {
      expect(assigned(float(value)).type).toBe(NodeType.Literal);
    }
  });
});

describe("the power steps a scaling ladder walks down", () => {
  it("steps down so a greedy walk never overshoots", () => {
    expect([...POWER_STEPS].sort((left, right) => right - left)).toEqual([...POWER_STEPS]);
  });

  it("reaches every exponent a double can carry", () => {
    for (const exponent of [0, 1, 52, 1023]) {
      let left = exponent;
      for (const step of POWER_STEPS) while (left >= step) left -= step;

      expect(left).toBe(0);
    }
  });

  it("scales by a factor the source spells exactly", () => {
    for (const step of POWER_STEPS) {
      expect(spelledValue(float(2 ** step))).toBe(2 ** step);
    }
  });
});
