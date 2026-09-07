import { describe, expect, it } from "vitest";
import {
  booleanType,
  doubleType,
  nullableNumericType,
  nullableStringType,
  nullishType,
  objectType,
  smiType,
  stringType,
} from "../../../src/optimizing/types/lattice.js";
import {
  aotScalarOf,
  carriesAbsence,
  isNumericScalar,
  isReferenceScalar,
  SCALAR_CODE,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_TEXT,
  SCALAR_VOID,
} from "../../../src/optimizing/types/scalar.js";

describe("the storage a lattice type lands in", () => {
  it("lays a whole number out as a whole number", () => {
    expect(aotScalarOf(smiType())).toBe(SCALAR_INT32);
  });

  it("widens a whole number that admits an absence to a double", () => {
    expect(aotScalarOf(nullableNumericType(smiType()))).toBe(SCALAR_FLOAT64);
  });

  it("leaves a double that admits an absence a double", () => {
    expect(aotScalarOf(nullableNumericType(doubleType()))).toBe(SCALAR_FLOAT64);
  });

  it("keeps a boolean in a whole number even beside the widening", () => {
    expect(aotScalarOf(booleanType())).toBe(SCALAR_INT32);
  });

  it("leaves a string that admits an absence a reference", () => {
    expect(aotScalarOf(nullableStringType())).toBe(SCALAR_STRING);
  });

  it("gives an absence of its own no storage to be read out of", () => {
    expect(aotScalarOf(nullishType())).toBe(SCALAR_VOID);
  });

  it("has no storage for an object whose shape is unknown", () => {
    expect(aotScalarOf(objectType(null))).toBeNull();
  });
});

describe("which storage can carry an absence beside a number", () => {
  it("says the double a widened number lands in can", () => {
    expect(carriesAbsence(SCALAR_FLOAT64)).toBe(true);
  });

  it("says a whole number cannot, having no payload to spare", () => {
    expect(carriesAbsence(SCALAR_INT32)).toBe(false);
  });

  it("says a reference cannot, carrying its absence as a null pointer", () => {
    expect(carriesAbsence(SCALAR_STRING)).toBe(false);
    expect(carriesAbsence(SCALAR_POINTER)).toBe(false);
  });

  it("agrees with what a number that admits an absence is laid out as", () => {
    expect(carriesAbsence(aotScalarOf(nullableNumericType(smiType()))!)).toBe(true);
    expect(carriesAbsence(aotScalarOf(smiType())!)).toBe(false);
    expect(carriesAbsence(aotScalarOf(stringType())!)).toBe(false);
  });
});

describe("how storage classes divide", () => {
  it("counts both number widths as numeric and nothing else", () => {
    expect([SCALAR_INT32, SCALAR_FLOAT64].every(isNumericScalar)).toBe(true);
    expect(
      [SCALAR_STRING, SCALAR_POINTER, SCALAR_TEXT, SCALAR_CODE, SCALAR_VOID].some(isNumericScalar),
    ).toBe(false);
  });

  it("counts a string and a pointer as references and code as neither", () => {
    expect([SCALAR_STRING, SCALAR_POINTER].every(isReferenceScalar)).toBe(true);
    expect(isReferenceScalar(SCALAR_CODE)).toBe(false);
  });
});
