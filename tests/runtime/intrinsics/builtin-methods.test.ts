import { describe, expect, it } from "vitest";
import { builtinMethodImplementation } from "../../../src/runtime/intrinsics/builtin-methods.js";
import { STRING_METHODS } from "../../../src/runtime/intrinsics/string-methods.js";
import {
  mkArray,
  mkNull,
  mkObject,
  mkSmi,
  mkString,
  mkUndefined,
  toNumber,
} from "../../../src/core/value/index.js";
import { createJSArray, createJSObject } from "../../../src/objects/heap/factory.js";

const HELLO = mkString("hello");

function charCodeAt(receiver = HELLO) {
  return builtinMethodImplementation("string", "char_code_at", receiver);
}

describe("builtinMethodImplementation", () => {
  it("maps a snake_case Tera name onto the camelCase runtime method", () => {
    expect(charCodeAt()).toBe(STRING_METHODS.charCodeAt);
  });

  it("resolves an implementation that computes the code unit", () => {
    const method = charCodeAt()!;

    expect(toNumber(method.call!([mkSmi(0)], HELLO))).toBe("h".charCodeAt(0));
    expect(toNumber(method.call!([mkSmi(4)], HELLO))).toBe("o".charCodeAt(0));
  });

  it("keeps the interpreter result for an index outside the string", () => {
    const method = charCodeAt()!;

    expect(Number.isNaN(toNumber(method.call!([mkSmi(9)], HELLO)))).toBe(true);
    expect(Number.isNaN(toNumber(method.call!([mkSmi(-1)], HELLO)))).toBe(true);
  });

  it("refuses a receiver that is not a string", () => {
    for (const receiver of [
      mkSmi(1),
      mkNull(),
      mkUndefined(),
      mkObject(createJSObject()),
      mkArray(createJSArray([])),
    ]) {
      expect(charCodeAt(receiver)).toBeNull();
    }
  });

  it("returns null for an owner it does not know", () => {
    expect(builtinMethodImplementation("Array", "char_code_at", HELLO)).toBeNull();
    expect(builtinMethodImplementation("", "char_code_at", HELLO)).toBeNull();
  });

  it("returns null for a method the owner does not have", () => {
    expect(builtinMethodImplementation("string", "not_a_method", HELLO)).toBeNull();
    expect(builtinMethodImplementation("string", "char_code_atx", HELLO)).toBeNull();
  });

  it("does not expose inherited object properties as methods", () => {
    for (const name of ["constructor", "__proto__", "has_own_property", "to_locale_string"]) {
      expect(builtinMethodImplementation("string", name, HELLO), name).toBeNull();
    }
  });

  it("resolves to the same implementation on every lookup", () => {
    expect(charCodeAt()).toBe(charCodeAt());
  });
});
