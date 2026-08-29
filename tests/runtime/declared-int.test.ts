import { describe, expect, it } from "vitest";
import { asDeclaredInt32, declaredInt32Return } from "../../src/runtime/declared-int.js";
import {
  getPayload,
  mkDouble,
  mkNull,
  mkSmi,
  mkString,
  mkUndefined,
  type TaggedValue,
} from "../../src/core/value/index.js";
import type { DeclaredSignature } from "../../src/optimizing/types/signature.js";

const signature = (returns: string | null): DeclaredSignature => ({ params: [], returns });

const carrier = (returns: string | null) => ({ declaredSignature: signature(returns) });

const answered = (value: TaggedValue) => getPayload(asDeclaredInt32(value) as never);

describe("recognising a declared int return", () => {
  it("answers for the declared return type of the signature", () => {
    expect(declaredInt32Return(carrier("int"))).toBe(true);
    expect(declaredInt32Return(carrier("float"))).toBe(false);
    expect(declaredInt32Return(carrier(null))).toBe(false);
    expect(declaredInt32Return({ declaredSignature: null })).toBe(false);
  });

  it("caches its answer on the function it was asked about", () => {
    const fn = carrier("int") as { declaredSignature: DeclaredSignature | null };
    expect(declaredInt32Return(fn)).toBe(true);
    fn.declaredSignature = signature("float");
    expect(declaredInt32Return(fn)).toBe(true);
  });
});

describe("coercing a declared int answer", () => {
  it("wraps an integer that overflows int32", () => {
    expect(answered(mkDouble(6553600000))).toBe(-2036334592);
    expect(answered(mkDouble(4294967296))).toBe(0);
    expect(answered(mkDouble(2147483648))).toBe(-2147483648);
    expect(answered(mkDouble(-2147483649))).toBe(2147483647);
  });

  it("leaves an integer already inside int32 alone", () => {
    expect(answered(mkDouble(2147483647))).toBe(2147483647);
    expect(answered(mkDouble(-2147483648))).toBe(-2147483648);
    expect(answered(mkSmi(42))).toBe(42);
  });

  it("leaves a value the declaration does not describe alone", () => {
    expect(answered(mkDouble(2.5))).toBe(2.5);
    expect(answered(mkDouble(NaN))).toBeNaN();
    expect(answered(mkDouble(Infinity))).toBe(Infinity);
    expect(answered(mkString("6553600000"))).toBe("6553600000");
    expect(asDeclaredInt32(mkUndefined())).toBe(mkUndefined());
    expect(asDeclaredInt32(mkNull())).toBe(mkNull());
  });

  it("is idempotent, so a tier may wrap what another tier already wrapped", () => {
    const once = asDeclaredInt32(mkDouble(6553600000));
    expect(getPayload(asDeclaredInt32(once) as never)).toBe(-2036334592);
  });
});
