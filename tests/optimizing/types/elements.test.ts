import { describe, expect, it } from "vitest";
import {
  PACKED_DOUBLE,
  PACKED_SMI,
  PACKED_TAGGED,
} from "../../../src/objects/elements/elements-kind.js";
import {
  elementsKindFor,
  latticeFromElementsKind,
} from "../../../src/optimizing/types/elements.js";
import { nominalLatticeType } from "../../../src/optimizing/types/declared.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import { aotScalarOf } from "../../../src/optimizing/types/scalar.js";

const typed = (declared: string) => nominalLatticeType(declared, buildClassTable([]));

describe("elementsKindFor", () => {
  it("packs a plain int as a smi and a plain float as a double", () => {
    expect(elementsKindFor(typed("int"))).toBe(PACKED_SMI);
    expect(elementsKindFor(typed("float"))).toBe(PACKED_DOUBLE);
  });

  it("packs a numeric that admits an absence as a double, which is what holds one", () => {
    expect(elementsKindFor(typed("int | null"))).toBe(PACKED_DOUBLE);
    expect(elementsKindFor(typed("int | undefined"))).toBe(PACKED_DOUBLE);
  });

  it("falls back to tagged for anything it has no packing for", () => {
    expect(elementsKindFor(typed("string"))).toBe(PACKED_TAGGED);
  });

  it("reads back a kind that stores the same scalar it was packed from", () => {
    const nullable = typed("int | null");
    const read = latticeFromElementsKind(elementsKindFor(nullable));

    expect(aotScalarOf(read)).toBe(aotScalarOf(nullable));
  });

  it("still reads a plain int back as an int", () => {
    const plain = typed("int");

    expect(aotScalarOf(latticeFromElementsKind(elementsKindFor(plain)))).toBe(aotScalarOf(plain));
  });
});
