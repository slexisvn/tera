import type { AotLegality } from "../analyses/aot-legality.js";
import { BackendLoweringError } from "../target/errors.js";
import { nominalLatticeType, type NominalTypes } from "../types/declared.js";
import {
  aotScalarOf,
  isStorableScalar,
  SCALAR_FLOAT64,
  SCALAR_STRING,
  SCALAR_VOID,
  type AotScalar,
} from "../types/scalar.js";

export function nativeArgumentScalar(
  declared: string | null,
  nominal: NominalTypes | null = null,
): AotScalar {
  return isStorableScalar(aotScalarOf(nominalLatticeType(declared, nominal))) ?? SCALAR_FLOAT64;
}

export function nativeReturnScalar(legality: AotLegality): AotScalar {
  if (legality.returnScalar === SCALAR_VOID) return SCALAR_VOID;
  if (legality.declaredReturn) return legality.returnScalar;
  if (legality.returnScalar === SCALAR_STRING) {
    throw new BackendLoweringError(
      "function returns a string without a declared return type",
    );
  }
  return SCALAR_FLOAT64;
}
