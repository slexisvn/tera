import {
  isReferenceScalar,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_VOID,
  type AotScalar,
} from "../types/scalar.js";

export const C_INT32 = "int32_t";
export const C_DOUBLE = "double";
export const C_STRING = "const char *";
export const C_POINTER = "unsigned char *";
export const C_VOID = "void";

export type CScalarType =
  | typeof C_INT32
  | typeof C_DOUBLE
  | typeof C_STRING
  | typeof C_POINTER
  | typeof C_VOID;

const C_BY_SCALAR = new Map<AotScalar, CScalarType>([
  [SCALAR_INT32, C_INT32],
  [SCALAR_FLOAT64, C_DOUBLE],
  [SCALAR_STRING, C_STRING],
  [SCALAR_POINTER, C_POINTER],
  [SCALAR_VOID, C_VOID],
]);

const C_POINTER_TYPES: ReadonlySet<CScalarType> = new Set<CScalarType>(
  [...C_BY_SCALAR]
    .filter(([scalar]) => isReferenceScalar(scalar))
    .map(([, type]) => type),
);

export function cTypeOf(scalar: AotScalar): CScalarType {
  const type = C_BY_SCALAR.get(scalar);
  if (type === undefined) throw new Error(`no C type for scalar ${scalar}`);
  return type;
}

export function declarationOf(type: CScalarType, name: string): string {
  return C_POINTER_TYPES.has(type) ? `${type}${name}` : `${type} ${name}`;
}

export function immutableDeclarationOf(type: CScalarType, name: string): string {
  const declaration = declarationOf(type, name);
  return C_POINTER_TYPES.has(type) ? declaration : `const ${declaration}`;
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
