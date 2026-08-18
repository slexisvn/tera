import { describe, it, expect } from "vitest";
import { hostBuiltin, nativeToTagged } from "../../../src/runtime/domain/host.js";
import {
  SMI_MAX,
  getPayload,
  isDouble,
  isSmi,
  mkUndefined,
  type ArrayValue,
  type ObjectValue,
} from "../../../src/core/value/index.js";

describe("nativeToTagged number canonicalization", () => {
  it("tags an integral number in smi range as a smi", () => {
    const value = nativeToTagged(3);
    expect(isSmi(value)).toBe(true);
    expect(getPayload(value)).toBe(3);
  });

  it("tags a negative integral number in smi range as a smi", () => {
    expect(isSmi(nativeToTagged(-7))).toBe(true);
  });

  it("tags a fractional number as a double", () => {
    const value = nativeToTagged(1.5);
    expect(isDouble(value)).toBe(true);
    expect(getPayload(value)).toBe(1.5);
  });

  it("tags an integral number beyond smi range as a double", () => {
    expect(isDouble(nativeToTagged(SMI_MAX + 1))).toBe(true);
  });

  it("canonicalizes array elements", () => {
    const value = nativeToTagged([0, 1.5]) as ArrayValue;
    const elements = getPayload(value).elements;
    expect(isSmi(elements[0]!)).toBe(true);
    expect(isDouble(elements[1]!)).toBe(true);
  });

  it("canonicalizes plain object properties", () => {
    const value = nativeToTagged({ count: 2, ratio: 0.5 }) as ObjectValue;
    expect(isSmi(getPayload(value).getProperty("count")!)).toBe(true);
    expect(isDouble(getPayload(value).getProperty("ratio")!)).toBe(true);
  });

  it("canonicalizes the result of a host builtin", () => {
    const builtin = hostBuiltin("three", () => 3);
    expect(isSmi(builtin.call!([], mkUndefined()))).toBe(true);
  });
});
