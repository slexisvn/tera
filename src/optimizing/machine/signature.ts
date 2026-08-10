import type { AotLegality } from "../analyses/aot-legality.js";
import { BackendLoweringError } from "../target/errors.js";
import { latticeFromDeclaredType } from "../types/declared.js";
import { aotScalarOf, SCALAR_FLOAT64, SCALAR_STRING, type AotScalar } from "../types/scalar.js";

export function nativeArgumentScalar(declared: string | null): AotScalar {
  return aotScalarOf(latticeFromDeclaredType(declared)) ?? SCALAR_FLOAT64;
}

export function nativeReturnScalar(legality: AotLegality): AotScalar {
  if (legality.declaredReturn) return legality.returnScalar;
  if (legality.returnScalar === SCALAR_STRING) {
    throw new BackendLoweringError(
      "function returns a string without a declared return type",
    );
  }
  return SCALAR_FLOAT64;
}
