import { describe, expect, it } from "vitest";
import {
  flatLattice,
  mapLattice,
  productLattice,
  setLattice,
  type FlatValue,
} from "../../../src/optimizing/infra/lattice.js";

describe("setLattice", () => {
  const lattice = setLattice<number>();

  it("uses the empty set as bottom", () => {
    expect([...lattice.bottom]).toEqual([]);
  });

  it("joins by union", () => {
    expect([...lattice.join(new Set([1, 2]), new Set([2, 3]))].sort()).toEqual([1, 2, 3]);
  });

  it("compares by membership rather than identity", () => {
    expect(lattice.equals(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(lattice.equals(new Set([1]), new Set([1, 2]))).toBe(false);
  });
});

describe("mapLattice", () => {
  const lattice = mapLattice<string, ReadonlySet<number>>(setLattice<number>());

  it("joins overlapping keys pointwise and carries over disjoint keys", () => {
    const joined = lattice.join(
      new Map([["x", new Set([1])]]),
      new Map([
        ["x", new Set([2])],
        ["y", new Set([9])],
      ]),
    );
    expect([...joined.get("x")!].sort()).toEqual([1, 2]);
    expect([...joined.get("y")!]).toEqual([9]);
  });

  it("treats a missing key as bottom when comparing", () => {
    expect(lattice.equals(new Map([["x", new Set<number>()]]), new Map())).toBe(true);
  });

  it("detects a difference on a single key", () => {
    expect(
      lattice.equals(new Map([["x", new Set([1])]]), new Map([["x", new Set([2])]])),
    ).toBe(false);
  });
});

describe("flatLattice", () => {
  const lattice = flatLattice<number>();
  const constant = (value: number): FlatValue<number> => ({ kind: "constant", value });

  it("raises bottom to a constant", () => {
    expect(lattice.join(lattice.bottom, constant(5))).toEqual(constant(5));
  });

  it("keeps equal constants and collapses conflicting ones to top", () => {
    expect(lattice.join(constant(5), constant(5))).toEqual(constant(5));
    expect(lattice.join(constant(5), constant(6)).kind).toBe("top");
  });

  it("keeps top absorbing", () => {
    expect(lattice.join({ kind: "top" }, constant(5)).kind).toBe("top");
  });

  it("compares by kind and by constant value", () => {
    expect(lattice.equals(constant(5), constant(5))).toBe(true);
    expect(lattice.equals(constant(5), constant(6))).toBe(false);
    expect(lattice.equals(lattice.bottom, { kind: "top" })).toBe(false);
  });
});

describe("productLattice", () => {
  const lattice = productLattice(setLattice<number>(), flatLattice<string>());

  it("joins each component independently", () => {
    const [set, flat] = lattice.join(
      [new Set([1]), { kind: "constant", value: "a" }],
      [new Set([2]), { kind: "constant", value: "b" }],
    );
    expect([...set].sort()).toEqual([1, 2]);
    expect(flat.kind).toBe("top");
  });

  it("is equal only when both components are equal", () => {
    const a = [new Set([1]), { kind: "constant", value: "x" }] as const;
    const b = [new Set([1]), { kind: "constant", value: "x" }] as const;
    const c = [new Set([1]), { kind: "constant", value: "y" }] as const;
    expect(lattice.equals(a, b)).toBe(true);
    expect(lattice.equals(a, c)).toBe(false);
  });
});
