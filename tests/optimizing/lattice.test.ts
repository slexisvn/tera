import { describe, it, expect } from "vitest";
import {
  TypeKind,
  anyType,
  taggedType,
  numberType,
  smiType,
  doubleType,
  booleanType,
  stringType,
  nullishType,
  neverType,
  objectType,
  arrayType,
  typeEquals,
  isSubtype,
  joinTypes,
  narrowType,
  typeFromConstant,
  typeFromTypeof,
} from "../../src/optimizing/types/lattice.js";

describe("typeEquals", () => {
  it("same singleton types are equal", () => {
    expect(typeEquals(smiType(), smiType())).toBe(true);
    expect(typeEquals(numberType(), numberType())).toBe(true);
    expect(typeEquals(stringType(), stringType())).toBe(true);
  });

  it("different kinds are not equal", () => {
    expect(typeEquals(smiType(), doubleType())).toBe(false);
    expect(typeEquals(stringType(), booleanType())).toBe(false);
  });

  it("objects compare by map", () => {
    expect(typeEquals(objectType(1), objectType(1))).toBe(true);
    expect(typeEquals(objectType(1), objectType(2))).toBe(false);
    expect(typeEquals(objectType(null), objectType(null))).toBe(true);
  });

  it("arrays compare by elementsKind", () => {
    expect(typeEquals(arrayType("PACKED_SMI"), arrayType("PACKED_SMI"))).toBe(true);
    expect(typeEquals(arrayType("PACKED_SMI"), arrayType("PACKED_DOUBLE"))).toBe(false);
  });

  it("returns false for null/undefined inputs", () => {
    expect(typeEquals(null, smiType())).toBe(false);
    expect(typeEquals(smiType(), null)).toBe(false);
  });
});

describe("isSubtype", () => {
  it("Never is subtype of everything", () => {
    expect(isSubtype(neverType(), smiType())).toBe(true);
    expect(isSubtype(neverType(), anyType())).toBe(true);
    expect(isSubtype(neverType(), objectType())).toBe(true);
  });

  it("everything is subtype of Any", () => {
    expect(isSubtype(smiType(), anyType())).toBe(true);
    expect(isSubtype(stringType(), anyType())).toBe(true);
    expect(isSubtype(objectType(), anyType())).toBe(true);
  });

  it("most types are subtype of Tagged (except Any)", () => {
    expect(isSubtype(smiType(), taggedType())).toBe(true);
    expect(isSubtype(stringType(), taggedType())).toBe(true);
    expect(isSubtype(anyType(), taggedType())).toBe(false);
  });

  it("Smi and Double are subtypes of Number", () => {
    expect(isSubtype(smiType(), numberType())).toBe(true);
    expect(isSubtype(doubleType(), numberType())).toBe(true);
    expect(isSubtype(stringType(), numberType())).toBe(false);
  });

  it("Array is subtype of Object(null)", () => {
    expect(isSubtype(arrayType(), objectType(null))).toBe(true);
    expect(isSubtype(arrayType(), objectType(42))).toBe(false);
  });

  it("Object with specific map is subtype of Object(null)", () => {
    expect(isSubtype(objectType(1), objectType(null))).toBe(true);
    expect(isSubtype(objectType(1), objectType(1))).toBe(true);
    expect(isSubtype(objectType(1), objectType(2))).toBe(false);
  });

  it("Array with specific kind is subtype of Array(null)", () => {
    expect(isSubtype(arrayType("PACKED_SMI"), arrayType(null))).toBe(true);
    expect(isSubtype(arrayType("PACKED_SMI"), arrayType("PACKED_SMI"))).toBe(true);
    expect(isSubtype(arrayType("PACKED_SMI"), arrayType("PACKED_DOUBLE"))).toBe(false);
  });

  it("returns false for null inputs", () => {
    expect(isSubtype(null, smiType())).toBe(false);
    expect(isSubtype(smiType(), null)).toBe(false);
  });
});

describe("joinTypes", () => {
  it("join of same type is that type", () => {
    expect(joinTypes(smiType(), smiType())).toBe(smiType());
  });

  it("join of Smi and Double is Number", () => {
    const result = joinTypes(smiType(), doubleType());
    expect(result.kind).toBe(TypeKind.Number);
  });

  it("join of Number and Smi is Number", () => {
    const result = joinTypes(numberType(), smiType());
    expect(result.kind).toBe(TypeKind.Number);
  });

  it("join with Never returns the other type", () => {
    expect(joinTypes(neverType(), smiType())).toBe(smiType());
    expect(joinTypes(stringType(), neverType())).toBe(stringType());
  });

  it("join of null and type returns type", () => {
    expect(joinTypes(null, smiType())).toBe(smiType());
    expect(joinTypes(smiType(), null)).toBe(smiType());
  });

  it("join of both null is Any", () => {
    expect(joinTypes(null, null).kind).toBe(TypeKind.Any);
  });

  it("join of Object variants is Object(null)", () => {
    const result = joinTypes(objectType(1), objectType(2));
    expect(result.kind).toBe(TypeKind.Object);
    expect(result.map).toBeNull();
  });

  it("join of Array variants is Array(null)", () => {
    const result = joinTypes(arrayType("PACKED_SMI"), arrayType("PACKED_DOUBLE"));
    expect(result.kind).toBe(TypeKind.Array);
    expect(result.elementsKind).toBeNull();
  });

  it("join of Object and Array is Object", () => {
    const result = joinTypes(objectType(), arrayType());
    expect(result.kind).toBe(TypeKind.Object);
  });

  it("join of unrelated types is Tagged", () => {
    const result = joinTypes(stringType(), booleanType());
    expect(result.kind).toBe(TypeKind.Tagged);
  });

  it("join of subtype and supertype returns supertype", () => {
    expect(joinTypes(smiType(), numberType()).kind).toBe(TypeKind.Number);
  });
});

describe("narrowType", () => {
  it("narrowing Any with Smi gives Smi", () => {
    expect(narrowType(anyType(), smiType())).toBe(smiType());
  });

  it("narrowing Number with Smi gives Smi", () => {
    expect(narrowType(numberType(), smiType())).toBe(smiType());
  });

  it("narrowing Number with Double gives Double", () => {
    expect(narrowType(numberType(), doubleType())).toBe(doubleType());
  });

  it("narrowing Smi with Number gives Smi", () => {
    expect(narrowType(smiType(), numberType())).toBe(smiType());
  });

  it("narrowing with incompatible types gives Never", () => {
    expect(narrowType(stringType(), smiType()).kind).toBe(TypeKind.Never);
  });

  it("narrowing Object with Array gives Array", () => {
    expect(narrowType(objectType(null), arrayType()).kind).toBe(TypeKind.Array);
  });

  it("narrowing Array with Object(null) gives Array", () => {
    expect(narrowType(arrayType(), objectType(null)).kind).toBe(TypeKind.Array);
  });

  it("narrowing Tagged with fact gives fact", () => {
    expect(narrowType(taggedType(), smiType())).toBe(smiType());
  });

  it("narrowing null gives fact", () => {
    expect(narrowType(null, smiType())).toBe(smiType());
  });

  it("narrowing with null fact gives current", () => {
    expect(narrowType(smiType(), null)).toBe(smiType());
  });
});

describe("typeFromConstant", () => {
  it("null gives Nullish", () => {
    expect(typeFromConstant(null).kind).toBe(TypeKind.Nullish);
  });

  it("undefined gives Nullish", () => {
    expect(typeFromConstant(undefined).kind).toBe(TypeKind.Nullish);
  });

  it("integer gives Smi", () => {
    expect(typeFromConstant(42).kind).toBe(TypeKind.Smi);
  });

  it("float gives Double", () => {
    expect(typeFromConstant(3.14).kind).toBe(TypeKind.Double);
  });

  it("string gives String", () => {
    expect(typeFromConstant("hello").kind).toBe(TypeKind.String);
  });

  it("boolean gives Boolean", () => {
    expect(typeFromConstant(true).kind).toBe(TypeKind.Boolean);
  });

  it("array gives Array", () => {
    expect(typeFromConstant([1, 2]).kind).toBe(TypeKind.Array);
  });

  it("object gives Object", () => {
    expect(typeFromConstant({ a: 1 }).kind).toBe(TypeKind.Object);
  });
});

describe("typeFromTypeof", () => {
  it("maps typeof strings to types", () => {
    expect(typeFromTypeof("string").kind).toBe(TypeKind.String);
    expect(typeFromTypeof("boolean").kind).toBe(TypeKind.Boolean);
    expect(typeFromTypeof("number").kind).toBe(TypeKind.Number);
    expect(typeFromTypeof("undefined").kind).toBe(TypeKind.Nullish);
    expect(typeFromTypeof("function").kind).toBe(TypeKind.Object);
    expect(typeFromTypeof("object").kind).toBe(TypeKind.Tagged);
  });

  it("unknown typeof returns null", () => {
    expect(typeFromTypeof("bigint")).toBeNull();
  });
});
