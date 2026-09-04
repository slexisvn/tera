import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

describe("the differential helper guards against a source it cannot observe", () => {
  it("refuses a program whose last statement only prints", () => {
    expect(() => differential(src("x = 1 + 1", "print(x)"))).toThrow(/not what it printed/);
  });

  it("compares a program that answers with the value itself", () => {
    expect(differential(src("x = 1 + 1", "x"))).toEqual(2);
  });

  it("still allows a print that is not the last statement", () => {
    expect(differential(src("x = 1 + 1", "print(x)", "x"))).toEqual(2);
  });
});
