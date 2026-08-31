import { acceptsNull, isNumericKind, TypeKind, type LatticeType } from "./lattice.js";
import { latticeFromElementsKind } from "./elements.js";

export const SCALAR_INT32 = "int32";
export const SCALAR_FLOAT64 = "float64";
export const SCALAR_STRING = "string";
export const SCALAR_TEXT = "text";
export const SCALAR_POINTER = "pointer";
export const SCALAR_CODE = "code";
export const SCALAR_VOID = "void";

export type AotScalar =
  | typeof SCALAR_INT32
  | typeof SCALAR_FLOAT64
  | typeof SCALAR_STRING
  | typeof SCALAR_TEXT
  | typeof SCALAR_POINTER
  | typeof SCALAR_CODE
  | typeof SCALAR_VOID;

export const TEXT_STORAGE_BYTES = 1024;

export const DEFAULT_TEXT_BUFFER_BYTES = 1 << 14;

export const TEXT_BUFFER_MINIMUM_BYTES = 1 << 8;

export const VALUE_SCALAR_PROP = "valueScalar";

const SCALAR_BY_KIND = new Map<string, AotScalar>([
  [TypeKind.Smi, SCALAR_INT32],
  [TypeKind.Boolean, SCALAR_INT32],
  [TypeKind.Double, SCALAR_FLOAT64],
  [TypeKind.Number, SCALAR_FLOAT64],
  [TypeKind.Any, SCALAR_FLOAT64],
  [TypeKind.Never, SCALAR_FLOAT64],
  [TypeKind.Tagged, SCALAR_FLOAT64],
  [TypeKind.String, SCALAR_STRING],
  [TypeKind.Nullish, SCALAR_VOID],
  [TypeKind.Array, SCALAR_POINTER],
]);

const SCALAR_WIDTHS = new Map<AotScalar, number>([
  [SCALAR_INT32, 4],
  [SCALAR_FLOAT64, 8],
  [SCALAR_STRING, 8],
  [SCALAR_TEXT, TEXT_STORAGE_BYTES],
  [SCALAR_POINTER, 8],
  [SCALAR_CODE, 8],
]);

export function aotScalarOf(type: LatticeType): AotScalar | null {
  if (type.kind === TypeKind.Object) {
    return type.map === null ? null : SCALAR_POINTER;
  }
  if (isNumericKind(type) && acceptsNull(type)) return SCALAR_FLOAT64;
  return SCALAR_BY_KIND.get(type.kind) ?? null;
}

export function aotElementScalarOf(type: LatticeType): AotScalar | null {
  if (type.kind !== TypeKind.Array) return null;
  const element = latticeFromElementsKind(type.elementsKind);
  if (element.kind === TypeKind.Any) return SCALAR_FLOAT64;
  return isStorableScalar(aotScalarOf(element));
}

export function isStorableScalar(scalar: AotScalar | null): AotScalar | null {
  return scalar === null || scalar === SCALAR_VOID ? null : scalar;
}

export function isNumericScalar(scalar: AotScalar): boolean {
  return scalar === SCALAR_INT32 || scalar === SCALAR_FLOAT64;
}

export function isReferenceScalar(scalar: AotScalar): boolean {
  return scalar === SCALAR_STRING || scalar === SCALAR_POINTER;
}

export function scalarStride(scalar: AotScalar): number {
  const shift = Math.log2(scalarWidth(scalar));
  if (!Number.isInteger(shift)) throw new Error(`no power-of-two stride for ${scalar}`);
  return shift;
}

export function scalarWidth(scalar: AotScalar): number {
  const width = SCALAR_WIDTHS.get(scalar);
  if (width === undefined) throw new Error(`no storage width for ${scalar}`);
  return width;
}

export function scalarAlignment(scalar: AotScalar): number {
  return scalar === SCALAR_TEXT ? scalarWidth(SCALAR_POINTER) : scalarWidth(scalar);
}
