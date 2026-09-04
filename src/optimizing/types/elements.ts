import {
  PACKED_DOUBLE,
  PACKED_SMI,
  PACKED_TAGGED,
} from "../../objects/elements/elements-kind.js";
import {
  acceptsNull,
  anyType,
  doubleType,
  smiType,
  stringType,
  TypeKind,
  type LatticeType,
} from "./lattice.js";

export const ELEMENT_REP_INT32 = "int32";
export const ELEMENT_REP_FLOAT64 = "float64";
export const ELEMENT_REP_STRING = "string";

export type ElementRep =
  | typeof ELEMENT_REP_INT32
  | typeof ELEMENT_REP_FLOAT64
  | typeof ELEMENT_REP_STRING;

const KIND_BY_TYPE = new Map<string, string>([
  [TypeKind.Smi, PACKED_SMI],
  [TypeKind.Double, PACKED_DOUBLE],
  [TypeKind.Number, PACKED_DOUBLE],
]);

const TYPE_BY_KIND = new Map<string, LatticeType>([
  [PACKED_SMI, smiType()],
  [PACKED_DOUBLE, doubleType()],
]);

const TYPE_BY_REP = new Map<string, LatticeType>([
  [ELEMENT_REP_INT32, smiType()],
  [ELEMENT_REP_FLOAT64, doubleType()],
  [ELEMENT_REP_STRING, stringType()],
]);

const REP_BY_KIND = new Map<string, ElementRep>([
  [PACKED_SMI, ELEMENT_REP_INT32],
  [PACKED_DOUBLE, ELEMENT_REP_FLOAT64],
]);

export function elementsKindFor(element: LatticeType): string {
  const packed = KIND_BY_TYPE.get(element.kind);
  if (packed === undefined) return PACKED_TAGGED;
  return acceptsNull(element) ? PACKED_DOUBLE : packed;
}

export function latticeFromElementsKind(kind: unknown): LatticeType {
  return TYPE_BY_KIND.get(String(kind)) ?? anyType();
}

export function latticeFromElementRep(rep: unknown): LatticeType | null {
  return TYPE_BY_REP.get(String(rep)) ?? null;
}

export function elementRepForKind(kind: unknown): ElementRep | null {
  return REP_BY_KIND.get(String(kind)) ?? null;
}
