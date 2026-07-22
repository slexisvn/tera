import { describe, it, expect } from "vitest";
import {
  mkSmi,
  mkDouble,
  mkBool,
  mkString,
  mkObject,
  mkFunction,
  mkArray,
  mkPromise,
  mkIterator,
  mkGenerator,
  mkRegex,
  mkSymbol,
  mkUndefined,
  mkNull,
  mkNumber,
  getTag,
  getPayload,
  isSmi,
  isDouble,
  isNumber,
  isBool,
  isString,
  isObject,
  isFunction,
  isArray,
  isPromise,
  isIterator,
  isGenerator,
  isRegex,
  isSymbol,
  isUndefined,
  isNull,
  isNullish,
  isPrimitive,
  isTaggedValue,
  toNumber,
  toBool,
  toString,
  stringCharAt,
  typeOf,
  strictEqual,
  abstractLooseEqual,
  abstractRelational,
  toPrimitive,
  getHeapId,
  JSSymbol,
  symbolFor,
  symbolKeyFor,
  TAG_SMI,
  TAG_DOUBLE,
  TAG_STRING,
  TAG_OBJECT,
  TAG_BOOL,
  TAG_UNDEFINED,
  TAG_NULL,
} from "../../src/core/value/index.js";

describe("tagged value roundtrip", () => {
  it("smi roundtrips through mkSmi/getPayload", () => {
    expect(getPayload(mkSmi(42))).toBe(42);
    expect(getPayload(mkSmi(-100))).toBe(-100);
    expect(getPayload(mkSmi(0))).toBe(0);
  });

  it("double roundtrips", () => {
    expect(getPayload(mkDouble(3.14))).toBeCloseTo(3.14);
    expect(getPayload(mkDouble(-0.5))).toBeCloseTo(-0.5);
  });

  it("bool roundtrips", () => {
    expect(getPayload(mkBool(true))).toBe(true);
    expect(getPayload(mkBool(false))).toBe(false);
  });

  it("string roundtrips", () => {
    expect(getPayload(mkString("hello"))).toBe("hello");
    expect(getPayload(mkString(""))).toBe("");
  });

  it("null and undefined roundtrip", () => {
    expect(getPayload(mkNull())).toBe(null);
    expect(getPayload(mkUndefined())).toBe(undefined);
  });

  it("object roundtrips", () => {
    const obj = { x: 1 };
    expect(getPayload(mkObject(obj))).toBe(obj);
  });

  it("function roundtrips", () => {
    const fn = { name: "test" };
    expect(getPayload(mkFunction(fn))).toBe(fn);
  });

  it("array roundtrips", () => {
    const arr = [1, 2, 3];
    expect(getPayload(mkArray(arr))).toBe(arr);
  });

  it("regex roundtrips with nativeRegex", () => {
    const v = mkRegex(/abc/gi);
    const p = getPayload(v);
    expect(p.nativeRegex.source).toBe("abc");
    expect(p.nativeRegex.flags).toBe("gi");
  });

  it("symbol roundtrips", () => {
    const sym = new JSSymbol("test");
    expect(getPayload(mkSymbol(sym))).toBe(sym);
  });
});

describe("getTag", () => {
  it("returns correct tags", () => {
    expect(getTag(mkSmi(1))).toBe(TAG_SMI);
    expect(getTag(mkDouble(1.5))).toBe(TAG_DOUBLE);
    expect(getTag(mkBool(true))).toBe(TAG_BOOL);
    expect(getTag(mkString("x"))).toBe(TAG_STRING);
    expect(getTag(mkObject({}))).toBe(TAG_OBJECT);
    expect(getTag(mkUndefined())).toBe(TAG_UNDEFINED);
    expect(getTag(mkNull())).toBe(TAG_NULL);
  });
});

describe("type predicates", () => {
  it("isSmi/isDouble/isNumber", () => {
    const smi = mkSmi(1);
    const dbl = mkDouble(1.5);
    expect(isSmi(smi)).toBe(true);
    expect(isDouble(smi)).toBe(false);
    expect(isDouble(dbl)).toBe(true);
    expect(isNumber(smi)).toBe(true);
    expect(isNumber(dbl)).toBe(true);
    expect(isNumber(mkString("x"))).toBe(false);
  });

  it("isBool", () => {
    expect(isBool(mkBool(true))).toBe(true);
    expect(isBool(mkBool(false))).toBe(true);
    expect(isBool(mkSmi(0))).toBe(false);
  });

  it("isString/isObject/isFunction/isArray", () => {
    expect(isString(mkString("x"))).toBe(true);
    expect(isObject(mkObject({}))).toBe(true);
    expect(isFunction(mkFunction({}))).toBe(true);
    expect(isArray(mkArray([]))).toBe(true);
  });

  it("isPromise/isIterator/isGenerator/isRegex/isSymbol", () => {
    expect(isPromise(mkPromise({}))).toBe(true);
    expect(isIterator(mkIterator({}))).toBe(true);
    expect(isGenerator(mkGenerator({}))).toBe(true);
    expect(isRegex(mkRegex(/x/))).toBe(true);
    expect(isSymbol(mkSymbol(new JSSymbol("s")))).toBe(true);
  });

  it("isUndefined/isNull/isNullish", () => {
    expect(isUndefined(mkUndefined())).toBe(true);
    expect(isNull(mkNull())).toBe(true);
    expect(isNullish(mkNull())).toBe(true);
    expect(isNullish(mkUndefined())).toBe(true);
    expect(isNullish(mkSmi(0))).toBe(false);
  });

  it("isPrimitive", () => {
    expect(isPrimitive(mkSmi(1))).toBe(true);
    expect(isPrimitive(mkString("x"))).toBe(true);
    expect(isPrimitive(mkBool(true))).toBe(true);
    expect(isPrimitive(mkNull())).toBe(true);
    expect(isPrimitive(mkUndefined())).toBe(true);
    expect(isPrimitive(mkObject({}))).toBe(false);
    expect(isPrimitive(mkArray([]))).toBe(false);
  });
});

describe("mkNumber", () => {
  it("creates smi for small integers", () => {
    const v = mkNumber(42);
    expect(isSmi(v)).toBe(true);
    expect(getPayload(v)).toBe(42);
  });

  it("creates double for non-integer", () => {
    const v = mkNumber(3.14);
    expect(isDouble(v)).toBe(true);
    expect(getPayload(v)).toBeCloseTo(3.14);
  });

  it("creates double for large integers beyond smi range", () => {
    const v = mkNumber(0x40000000);
    expect(isDouble(v)).toBe(true);
  });

  it("creates smi for negative in range", () => {
    const v = mkNumber(-100);
    expect(isSmi(v)).toBe(true);
    expect(getPayload(v)).toBe(-100);
  });
});

describe("toNumber", () => {
  it("smi returns its value", () => {
    expect(toNumber(mkSmi(42))).toBe(42);
  });

  it("double returns its value", () => {
    expect(toNumber(mkDouble(3.14))).toBeCloseTo(3.14);
  });

  it("true => 1, false => 0", () => {
    expect(toNumber(mkBool(true))).toBe(1);
    expect(toNumber(mkBool(false))).toBe(0);
  });

  it("numeric string converts", () => {
    expect(toNumber(mkString("123"))).toBe(123);
    expect(toNumber(mkString("3.14"))).toBeCloseTo(3.14);
  });

  it("empty string => 0", () => {
    expect(toNumber(mkString(""))).toBe(0);
  });

  it("non-numeric string => NaN", () => {
    expect(toNumber(mkString("abc"))).toBeNaN();
  });

  it("null => 0", () => {
    expect(toNumber(mkNull())).toBe(0);
  });

  it("undefined => NaN", () => {
    expect(toNumber(mkUndefined())).toBeNaN();
  });

  it("empty array => 0", () => {
    expect(toNumber(mkArray({ elements: [] }))).toBe(0);
  });

  it("single-element numeric array => that number", () => {
    expect(toNumber(mkArray({ elements: [mkSmi(7)] }))).toBe(7);
  });

  it("multi-element array => NaN", () => {
    expect(toNumber(mkArray({ elements: [mkSmi(1), mkSmi(2)] }))).toBeNaN();
  });

  it("plain object => NaN", () => {
    expect(toNumber(mkObject({}))).toBeNaN();
  });
});

describe("toBool", () => {
  it("false/null/undefined => false", () => {
    expect(toBool(mkBool(false))).toBe(false);
    expect(toBool(mkNull())).toBe(false);
    expect(toBool(mkUndefined())).toBe(false);
  });

  it("true => true", () => {
    expect(toBool(mkBool(true))).toBe(true);
  });

  it("0 => false, nonzero => true", () => {
    expect(toBool(mkSmi(0))).toBe(false);
    expect(toBool(mkSmi(1))).toBe(true);
    expect(toBool(mkSmi(-1))).toBe(true);
  });

  it("NaN => false, other double => true", () => {
    expect(toBool(mkDouble(NaN))).toBe(false);
    expect(toBool(mkDouble(0))).toBe(false);
    expect(toBool(mkDouble(1.5))).toBe(true);
  });

  it("empty string => false, non-empty => true", () => {
    expect(toBool(mkString(""))).toBe(false);
    expect(toBool(mkString("x"))).toBe(true);
  });

  it("object/array => true", () => {
    expect(toBool(mkObject({}))).toBe(true);
    expect(toBool(mkArray([]))).toBe(true);
  });
});

describe("stringCharAt", () => {
  it("reads a character by a non-negative index", () => {
    expect(stringCharAt("hello", 0)).toBe("h");
    expect(stringCharAt("hello", 4)).toBe("o");
  });

  it("counts a negative index back from the end", () => {
    expect(stringCharAt("hello", -1)).toBe("o");
    expect(stringCharAt("hello", -5)).toBe("h");
  });

  it("returns undefined outside the bounds in either direction", () => {
    expect(stringCharAt("hello", 5)).toBeUndefined();
    expect(stringCharAt("hello", -6)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(stringCharAt("", 0)).toBeUndefined();
    expect(stringCharAt("", -1)).toBeUndefined();
  });
});

describe("toString", () => {
  it("numbers", () => {
    expect(toString(mkSmi(42))).toBe("42");
    expect(toString(mkDouble(3.14))).toBe("3.14");
  });

  it("booleans", () => {
    expect(toString(mkBool(true))).toBe("true");
    expect(toString(mkBool(false))).toBe("false");
  });

  it("null/undefined", () => {
    expect(toString(mkNull())).toBe("null");
    expect(toString(mkUndefined())).toBe("undefined");
  });

  it("string passthrough", () => {
    expect(toString(mkString("hello"))).toBe("hello");
  });

  it("function shows name", () => {
    expect(toString(mkFunction({ name: "foo" }))).toBe("[Function: foo]");
  });

  it("promise shows state", () => {
    expect(toString(mkPromise({ state: "pending" }))).toBe("[Promise pending]");
  });

  it("regex shows pattern", () => {
    expect(toString(mkRegex(/abc/g))).toBe("/abc/g");
  });

  it("symbol shows description", () => {
    expect(toString(mkSymbol(new JSSymbol("test")))).toBe("Symbol(test)");
    expect(toString(mkSymbol(new JSSymbol(undefined)))).toBe("Symbol()");
  });

  it("array joins elements with commas", () => {
    const arr = mkArray({ elements: [mkSmi(0), mkSmi(5), mkSmi(9)] });
    expect(toString(arr)).toBe("0,5,9");
  });

  it("empty array stringifies to empty string", () => {
    expect(toString(mkArray({ elements: [] }))).toBe("");
  });

  it("array renders null and undefined elements as empty", () => {
    const arr = mkArray({ elements: [mkSmi(1), mkNull(), mkUndefined()] });
    expect(toString(arr)).toBe("1,,");
  });

  it("nested arrays stringify recursively", () => {
    const inner = mkArray({ elements: [mkSmi(2), mkSmi(3)] });
    const arr = mkArray({ elements: [mkSmi(1), inner] });
    expect(toString(arr)).toBe("1,2,3");
  });

  it("plain object stringifies to [object Object]", () => {
    expect(toString(mkObject({}))).toBe("[object Object]");
  });
});

describe("typeOf", () => {
  it("returns correct typeof strings", () => {
    expect(typeOf(mkSmi(1))).toBe("number");
    expect(typeOf(mkDouble(1.5))).toBe("number");
    expect(typeOf(mkBool(true))).toBe("boolean");
    expect(typeOf(mkString("x"))).toBe("string");
    expect(typeOf(mkFunction({}))).toBe("function");
    expect(typeOf(mkObject({}))).toBe("object");
    expect(typeOf(mkArray([]))).toBe("object");
    expect(typeOf(mkNull())).toBe("object");
    expect(typeOf(mkUndefined())).toBe("undefined");
    expect(typeOf(mkSymbol(new JSSymbol("s")))).toBe("symbol");
  });
});

describe("strictEqual", () => {
  it("same smi values are equal", () => {
    expect(strictEqual(mkSmi(42), mkSmi(42))).toBe(true);
  });

  it("different smi values are not equal", () => {
    expect(strictEqual(mkSmi(1), mkSmi(2))).toBe(false);
  });

  it("smi and double with same numeric value are not equal (different tag)", () => {
    expect(strictEqual(mkSmi(1), mkDouble(1))).toBe(false);
  });

  it("null === null, undefined === undefined", () => {
    expect(strictEqual(mkNull(), mkNull())).toBe(true);
    expect(strictEqual(mkUndefined(), mkUndefined())).toBe(true);
  });

  it("null !== undefined", () => {
    expect(strictEqual(mkNull(), mkUndefined())).toBe(false);
  });

  it("same string values are equal", () => {
    expect(strictEqual(mkString("abc"), mkString("abc"))).toBe(true);
  });

  it("different strings are not equal", () => {
    expect(strictEqual(mkString("a"), mkString("b"))).toBe(false);
  });
});

describe("abstractLooseEqual", () => {
  it("null == undefined", () => {
    expect(abstractLooseEqual(mkNull(), mkUndefined())).toBe(true);
    expect(abstractLooseEqual(mkUndefined(), mkNull())).toBe(true);
  });

  it("null != 0", () => {
    expect(abstractLooseEqual(mkNull(), mkSmi(0))).toBe(false);
  });

  it("smi == double with same value", () => {
    expect(abstractLooseEqual(mkSmi(1), mkDouble(1))).toBe(true);
  });

  it("number == numeric string", () => {
    expect(abstractLooseEqual(mkSmi(42), mkString("42"))).toBe(true);
    expect(abstractLooseEqual(mkString("42"), mkSmi(42))).toBe(true);
  });

  it("true == 1", () => {
    expect(abstractLooseEqual(mkBool(true), mkSmi(1))).toBe(true);
  });

  it("false == 0", () => {
    expect(abstractLooseEqual(mkBool(false), mkSmi(0))).toBe(true);
  });

  it("different types that don't coerce are not equal", () => {
    expect(abstractLooseEqual(mkString("abc"), mkSmi(0))).toBe(false);
  });
});

describe("abstractRelational", () => {
  it("orders numbers", () => {
    expect(abstractRelational(mkSmi(1), mkSmi(2))).toBe(-1);
    expect(abstractRelational(mkSmi(2), mkSmi(2))).toBe(0);
    expect(abstractRelational(mkSmi(3), mkSmi(2))).toBe(1);
  });

  it("compares strings lexicographically", () => {
    expect(abstractRelational(mkString("a"), mkString("b"))).toBe(-1);
    expect(abstractRelational(mkString("a"), mkString("a"))).toBe(0);
    expect(abstractRelational(mkString("10"), mkString("9"))).toBe(-1);
  });

  it("coerces a numeric string against a number", () => {
    expect(abstractRelational(mkString("5"), mkSmi(5))).toBe(0);
  });

  it("compares arrays via their primitive string form", () => {
    const left = mkArray({ elements: [mkSmi(1), mkSmi(2)] });
    const right = mkArray({ elements: [mkSmi(1), mkSmi(2)] });
    expect(abstractRelational(left, right)).toBe(0);
  });

  it("returns NaN when a side is not a number", () => {
    expect(abstractRelational(mkString("a"), mkSmi(1))).toBeNaN();
    expect(abstractRelational(mkUndefined(), mkSmi(1))).toBeNaN();
  });
});

describe("getHeapId", () => {
  it("returns -1 for smi/bool/null/undefined", () => {
    expect(getHeapId(mkSmi(1))).toBe(-1);
    expect(getHeapId(mkBool(true))).toBe(-1);
    expect(getHeapId(mkNull())).toBe(-1);
    expect(getHeapId(mkUndefined())).toBe(-1);
  });

  it("returns positive id for heap values", () => {
    expect(getHeapId(mkString("x"))).toBeGreaterThan(0);
    expect(getHeapId(mkObject({}))).toBeGreaterThan(0);
  });
});

describe("isTaggedValue", () => {
  it("recognizes valid tagged values", () => {
    expect(isTaggedValue(mkSmi(0))).toBe(true);
    expect(isTaggedValue(mkBool(true))).toBe(true);
    expect(isTaggedValue(mkNull())).toBe(true);
    expect(isTaggedValue(mkUndefined())).toBe(true);
    expect(isTaggedValue(mkString("x"))).toBe(true);
  });

  it("rejects non-tagged values", () => {
    expect(isTaggedValue("string")).toBe(false);
    expect(isTaggedValue(NaN)).toBe(false);
    expect(isTaggedValue(Infinity)).toBe(false);
  });
});

describe("symbolFor / symbolKeyFor", () => {
  it("returns same tagged value for same key", () => {
    const a = symbolFor("shared");
    const b = symbolFor("shared");
    expect(a).toBe(b);
  });

  it("symbolKeyFor returns key for global symbol", () => {
    const sym = symbolFor("mykey");
    expect(symbolKeyFor(sym)).toBe("mykey");
  });
});
