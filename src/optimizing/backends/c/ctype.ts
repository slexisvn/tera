import { TypeKind, type LatticeType } from "../../types/lattice.js";
import { latticeFromElementsKind } from "../../types/elements.js";

export const C_INT32 = "int32_t";
export const C_DOUBLE = "double";
export const C_STRING = "const char *";

export type CScalarType = typeof C_INT32 | typeof C_DOUBLE | typeof C_STRING;

const SCALAR_BY_KIND = new Map<string, CScalarType>([
  [TypeKind.Smi, C_INT32],
  [TypeKind.Boolean, C_INT32],
  [TypeKind.Double, C_DOUBLE],
  [TypeKind.Number, C_DOUBLE],
  [TypeKind.Any, C_DOUBLE],
  [TypeKind.Never, C_DOUBLE],
  [TypeKind.Tagged, C_DOUBLE],
  [TypeKind.String, C_STRING],
]);

export function cScalarType(type: LatticeType): CScalarType | null {
  return SCALAR_BY_KIND.get(type.kind) ?? null;
}

export function cElementType(type: LatticeType): CScalarType | null {
  if (type.kind !== TypeKind.Array) return null;
  const element = latticeFromElementsKind(type.elementsKind);
  return element.kind === TypeKind.Any ? C_DOUBLE : cScalarType(element);
}

export function isNumericType(type: CScalarType): boolean {
  return type === C_INT32 || type === C_DOUBLE;
}

export function declarationOf(type: CScalarType, name: string): string {
  return type === C_STRING ? `${type}${name}` : `${type} ${name}`;
}
