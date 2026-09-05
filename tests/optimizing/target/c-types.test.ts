import { describe, expect, it } from "vitest";
import {
  cTypeOf,
  cTypedefs,
  declarationOf,
  immutableDeclarationOf,
  prototypeOf,
  C_ANY_POINTER,
  C_CHAR,
  C_CODE,
  C_DOUBLE,
  C_INT32,
  C_NARROW_TEXT_UNIT,
  C_POINTER,
  C_STRING,
  C_WIDE_TEXT_UNIT,
} from "../../../src/optimizing/target/c-types.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
} from "../../../src/optimizing/types/scalar.js";

const TEXT_UNITS = [C_WIDE_TEXT_UNIT, C_NARROW_TEXT_UNIT] as const;

describe("the typedefs a compiled header carries", () => {
  it("names the character type after the unit the target stores text in", () => {
    for (const unit of TEXT_UNITS) {
      expect(cTypedefs(unit)).toContain(`typedef ${unit} ${C_CHAR};`);
    }

    expect(cTypedefs(C_WIDE_TEXT_UNIT)).not.toBe(cTypedefs(C_NARROW_TEXT_UNIT));
  });

  it("leaves the spelling of a string parameter the same whichever unit is chosen", () => {
    for (const unit of TEXT_UNITS) {
      expect(cTypedefs(unit)).toContain(C_CHAR);
      expect(cTypeOf(SCALAR_STRING)).toBe(C_STRING);
      expect(C_STRING).toContain(C_CHAR);
    }
  });

  it("guards both typedefs so a header included twice declares them once", () => {
    const guarded = cTypedefs(C_WIDE_TEXT_UNIT).split(String.fromCharCode(10));

    expect(guarded[0]).toMatch(/^#ifndef \w+$/);
    expect(guarded[guarded.length - 1]).toBe("#endif");
    expect(guarded.filter((line) => line.startsWith("typedef"))).toHaveLength(2);
  });

  it("declares the code type inside the same guard as the character type", () => {
    expect(cTypedefs(C_WIDE_TEXT_UNIT)).toContain(`(*${C_CODE})`);
  });
});

describe("how a C declaration spells a name after its type", () => {
  it("attaches the name straight to a pointer type", () => {
    for (const type of [C_ANY_POINTER, C_POINTER, C_STRING]) {
      expect(declarationOf(type, "p0")).toBe(`${type}p0`);
    }
  });

  it("separates the name from a value type", () => {
    for (const type of [C_INT32, C_DOUBLE, C_CODE]) {
      expect(declarationOf(type, "p0")).toBe(`${type} p0`);
    }
  });

  it("holds a value type immutable but leaves a pointer alone", () => {
    expect(immutableDeclarationOf(C_INT32, "p0")).toBe(`const ${C_INT32} p0`);
    expect(immutableDeclarationOf(C_ANY_POINTER, "p0")).toBe(`${C_ANY_POINTER}p0`);
  });

  it("spells a prototype from the scalars a function was lowered for", () => {
    expect(prototypeOf("greet", SCALAR_STRING, [SCALAR_STRING, SCALAR_INT32])).toBe(
      `${C_STRING} greet(${C_STRING}p0, ${C_INT32} p1)`,
    );
    expect(prototypeOf("size", SCALAR_INT32, [])).toBe(`${C_INT32} size(void)`);
    expect(prototypeOf("copy", SCALAR_POINTER, [SCALAR_FLOAT64])).toBe(
      `${C_POINTER} copy(${C_DOUBLE} p0)`,
    );
  });
});
