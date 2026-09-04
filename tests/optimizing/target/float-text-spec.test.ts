import { describe, expect, it } from "vitest";
import {
  ABSENCE_VALUES,
  BIGNUM_NAMES,
  floatTextKeys,
  INFINITY_TEXT,
  NEGATIVE_INFINITY_TEXT,
  NOT_A_NUMBER_TEXT,
  NULL_TEXT,
  UNDEFINED_TEXT,
  type FloatTextKeys,
} from "../../../src/optimizing/target/float-text-spec.js";

const PREFIX = "program";

const keys = (prefix: string = PREFIX): FloatTextKeys => floatTextKeys(prefix);

function everyKeyOf(spec: FloatTextKeys): string[] {
  return [
    spec.state,
    spec.digits,
    spec.exponent,
    spec.notANumber,
    spec.infinity,
    spec.negativeInfinity,
    ...BIGNUM_NAMES.map((name) => spec.bignum(name)),
    ...ABSENCE_VALUES.map((absence) => spec.ofText(absence.text)),
  ];
}

describe("floatTextKeys names every constant the float-text routine spells", () => {
  it("answers a key for each absence value the language carries", () => {
    const spec = keys();

    for (const absence of ABSENCE_VALUES) {
      expect(spec.ofText(absence.text)).toContain(absence.text);
    }
  });

  it("tells the two absences apart rather than folding them onto one key", () => {
    const spec = keys();

    expect(spec.ofText(NULL_TEXT)).not.toBe(spec.ofText(UNDEFINED_TEXT));
  });

  it("answers a key for each number that has no digits to print", () => {
    const spec = keys();

    expect(spec.ofText(NOT_A_NUMBER_TEXT)).toBe(spec.notANumber);
    expect(spec.ofText(INFINITY_TEXT)).toBe(spec.infinity);
    expect(spec.ofText(NEGATIVE_INFINITY_TEXT)).toBe(spec.negativeInfinity);
  });

  it("hands out no two keys that name the same storage", () => {
    const all = everyKeyOf(keys());

    expect(new Set(all).size).toBe(all.length);
  });

  it("prefixes every key with the module it was built for", () => {
    for (const key of everyKeyOf(keys())) {
      expect(key.startsWith(`${PREFIX}:float-`)).toBe(true);
    }
  });

  it("keeps two modules' keys apart so their storage cannot collide", () => {
    const mine = new Set(everyKeyOf(keys("mine")));

    expect(everyKeyOf(keys("yours")).some((key) => mine.has(key))).toBe(false);
  });

  it("refuses a text it holds no key for", () => {
    expect(() => keys().ofText("1.5")).toThrow("no float text key for 1.5");
  });
});
