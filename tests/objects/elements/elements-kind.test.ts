import { describe, it, expect } from "vitest";
import {
  PACKED_SMI,
  PACKED_DOUBLE,
  PACKED_TAGGED,
  HOLEY_SMI,
  HOLEY_DOUBLE,
  HOLEY_TAGGED,
  mergeElementsKind,
  inferElementsKind,
} from "../../../src/objects/elements/elements-kind.js";
import { mkSmi, mkDouble, mkString, mkObject } from "../../../src/core/value/index.js";

describe("mergeElementsKind", () => {
  it("SMI + double -> PACKED_DOUBLE", () => {
    expect(mergeElementsKind(PACKED_SMI, mkDouble(1.5))).toBe(PACKED_DOUBLE);
  });

  it("SMI + string -> PACKED_TAGGED", () => {
    expect(mergeElementsKind(PACKED_SMI, mkString("x"))).toBe(PACKED_TAGGED);
  });

  it("DOUBLE + string -> PACKED_TAGGED", () => {
    expect(mergeElementsKind(PACKED_DOUBLE, mkString("x"))).toBe(PACKED_TAGGED);
  });

  it("never downgrades from TAGGED", () => {
    expect(mergeElementsKind(PACKED_TAGGED, mkSmi(1))).toBe(PACKED_TAGGED);
    expect(mergeElementsKind(HOLEY_TAGGED, mkSmi(1))).toBe(HOLEY_TAGGED);
  });

  it("never downgrades from DOUBLE to SMI", () => {
    expect(mergeElementsKind(PACKED_DOUBLE, mkSmi(1))).toBe(PACKED_DOUBLE);
  });

  it("makesHole flag transitions packed to holey", () => {
    expect(mergeElementsKind(PACKED_SMI, mkSmi(1), true)).toBe(HOLEY_SMI);
    expect(mergeElementsKind(PACKED_DOUBLE, mkDouble(1.5), true)).toBe(HOLEY_DOUBLE);
    expect(mergeElementsKind(PACKED_TAGGED, mkString("x"), true)).toBe(HOLEY_TAGGED);
  });

  it("holey is sticky even without makesHole", () => {
    expect(mergeElementsKind(HOLEY_SMI, mkSmi(1))).toBe(HOLEY_SMI);
    expect(mergeElementsKind(HOLEY_DOUBLE, mkSmi(1))).toBe(HOLEY_DOUBLE);
  });

  it("holey + type promotion combines both", () => {
    expect(mergeElementsKind(HOLEY_SMI, mkDouble(1.5))).toBe(HOLEY_DOUBLE);
    expect(mergeElementsKind(HOLEY_DOUBLE, mkObject({}))).toBe(HOLEY_TAGGED);
  });
});

describe("inferElementsKind", () => {
  it("empty array -> PACKED_SMI", () => {
    expect(inferElementsKind([])).toBe(PACKED_SMI);
  });

  it("all smi -> PACKED_SMI", () => {
    expect(inferElementsKind([mkSmi(1), mkSmi(2), mkSmi(3)])).toBe(PACKED_SMI);
  });

  it("mixed smi and double -> PACKED_DOUBLE", () => {
    expect(inferElementsKind([mkSmi(1), mkDouble(2.5)])).toBe(PACKED_DOUBLE);
  });

  it("any tagged value -> PACKED_TAGGED", () => {
    expect(inferElementsKind([mkSmi(1), mkString("x")])).toBe(PACKED_TAGGED);
  });

  it("undefined holes transition to holey", () => {
    expect(inferElementsKind([mkSmi(1), undefined, mkSmi(3)])).toBe(HOLEY_SMI);
    expect(inferElementsKind([mkDouble(1.1), undefined])).toBe(HOLEY_DOUBLE);
    expect(inferElementsKind([mkString("a"), undefined])).toBe(HOLEY_TAGGED);
  });

  it("holes + type promotion combine", () => {
    expect(inferElementsKind([mkSmi(1), undefined, mkDouble(2.5)])).toBe(HOLEY_DOUBLE);
  });
});
