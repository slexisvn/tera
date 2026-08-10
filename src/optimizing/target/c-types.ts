import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
  type AotScalar,
} from "../types/scalar.js";

export const C_INT32 = "int32_t";
export const C_DOUBLE = "double";
export const C_STRING = "const char *";

export type CScalarType = typeof C_INT32 | typeof C_DOUBLE | typeof C_STRING;

const C_BY_SCALAR = new Map<AotScalar, CScalarType>([
  [SCALAR_INT32, C_INT32],
  [SCALAR_FLOAT64, C_DOUBLE],
  [SCALAR_STRING, C_STRING],
]);

export function cTypeOf(scalar: AotScalar): CScalarType {
  const type = C_BY_SCALAR.get(scalar);
  if (type === undefined) throw new Error(`no C type for scalar ${scalar}`);
  return type;
}

export function declarationOf(type: CScalarType, name: string): string {
  return type === C_STRING ? `${type}${name}` : `${type} ${name}`;
}

export function prototypeOf(
  symbol: string,
  returns: AotScalar,
  parameters: readonly AotScalar[],
): string {
  const params = parameters.map((scalar, index) =>
    declarationOf(cTypeOf(scalar), `p${index}`),
  );
  return `${cTypeOf(returns)} ${symbol}(${params.length > 0 ? params.join(", ") : "void"})`;
}
