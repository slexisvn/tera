import { TypeKind, type LatticeType } from "./lattice.js";
import { latticeFromElementsKind } from "./elements.js";

export const SCALAR_INT32 = "int32";
export const SCALAR_FLOAT64 = "float64";
export const SCALAR_STRING = "string";

export type AotScalar =
  | typeof SCALAR_INT32
  | typeof SCALAR_FLOAT64
  | typeof SCALAR_STRING;

const SCALAR_BY_KIND = new Map<string, AotScalar>([
  [TypeKind.Smi, SCALAR_INT32],
  [TypeKind.Boolean, SCALAR_INT32],
  [TypeKind.Double, SCALAR_FLOAT64],
  [TypeKind.Number, SCALAR_FLOAT64],
  [TypeKind.Any, SCALAR_FLOAT64],
  [TypeKind.Never, SCALAR_FLOAT64],
  [TypeKind.Tagged, SCALAR_FLOAT64],
  [TypeKind.String, SCALAR_STRING],
]);

export function aotScalarOf(type: LatticeType): AotScalar | null {
  return SCALAR_BY_KIND.get(type.kind) ?? null;
}

export function aotElementScalarOf(type: LatticeType): AotScalar | null {
  if (type.kind !== TypeKind.Array) return null;
  const element = latticeFromElementsKind(type.elementsKind);
  return element.kind === TypeKind.Any ? SCALAR_FLOAT64 : aotScalarOf(element);
}

export function isNumericScalar(scalar: AotScalar): boolean {
  return scalar === SCALAR_INT32 || scalar === SCALAR_FLOAT64;
}
