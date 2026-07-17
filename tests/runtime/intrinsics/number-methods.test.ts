import { describe, it, expect } from "vitest";
import { NUMBER_METHODS } from "../../../src/runtime/intrinsics/number-methods.js";
import {
  mkSmi,
  mkDouble,
  mkNumber,
  getPayload,
} from "../../../src/core/value/index.js";

function callMethod(name, thisVal, ...args) {
  return NUMBER_METHODS[name].call(args, thisVal);
}

function str(val) {
  return getPayload(val);
}

describe("NUMBER_METHODS", () => {
  describe("toString", () => {
    it("default base-10 conversion", () => {
      expect(str(callMethod("toString", mkSmi(255)))).toBe("255");
      expect(str(callMethod("toString", mkDouble(3.14)))).toBe("3.14");
      expect(str(callMethod("toString", mkSmi(0)))).toBe("0");
      expect(str(callMethod("toString", mkSmi(-42)))).toBe("-42");
    });

    it("converts to different radixes", () => {
      const cases = [
        [255, 16, "ff"],
        [255, 2, "11111111"],
        [255, 8, "377"],
        [10, 36, "a"],
        [100, 3, "10201"],
      ];
      for (const [num, radix, expected] of cases) {
        expect(str(callMethod("toString", mkSmi(num), mkSmi(radix)))).toBe(expected);
      }
    });
  });

  describe("toFixed", () => {
    it("formats with specified decimal places", () => {
      expect(str(callMethod("toFixed", mkDouble(3.14159), mkSmi(2)))).toBe("3.14");
      expect(str(callMethod("toFixed", mkDouble(3.14159), mkSmi(4)))).toBe("3.1416");
      expect(str(callMethod("toFixed", mkSmi(5), mkSmi(3)))).toBe("5.000");
    });

    it("defaults to 0 decimal places", () => {
      expect(str(callMethod("toFixed", mkDouble(3.7)))).toBe("4");
    });
  });

  describe("toPrecision", () => {
    it("formats to specified significant digits", () => {
      expect(str(callMethod("toPrecision", mkDouble(123.456), mkSmi(5)))).toBe("123.46");
      expect(str(callMethod("toPrecision", mkDouble(0.00123), mkSmi(2)))).toBe("0.0012");
      expect(str(callMethod("toPrecision", mkDouble(123.456), mkSmi(2)))).toBe("1.2e+2");
    });

    it("without precision argument returns full representation", () => {
      expect(str(callMethod("toPrecision", mkSmi(42)))).toBe("42");
    });
  });

  describe("toExponential", () => {
    it("formats in exponential notation", () => {
      expect(str(callMethod("toExponential", mkSmi(12345), mkSmi(2)))).toBe("1.23e+4");
      expect(str(callMethod("toExponential", mkDouble(0.0042), mkSmi(1)))).toBe("4.2e-3");
    });

    it("without fraction digits uses default", () => {
      const result = str(callMethod("toExponential", mkSmi(100)));
      expect(result).toMatch(/^1/);
      expect(result).toContain("e+2");
    });
  });

  describe("valueOf", () => {
    it("returns the tagged number value", () => {
      expect(callMethod("valueOf", mkSmi(42))).toBe(mkSmi(42));
      const d = mkDouble(1.5);
      expect(callMethod("valueOf", d)).toBe(d);
    });
  });
});
