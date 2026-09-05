import {
  isReferenceScalar,
  SCALAR_CODE,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_VOID,
  type AotScalar,
} from "../types/scalar.js";

export const C_INT32 = "int32_t";
export const C_DOUBLE = "double";
export const C_CHAR = "tera_char";
export const C_STRING = `const ${C_CHAR} *`;
export const C_POINTER = "unsigned char *";
export const C_ANY_POINTER = "void *";
export const C_CODE = "tera_fn";
export const C_VOID = "void";

export const C_WIDE_TEXT_UNIT = "uint16_t";
export const C_NARROW_TEXT_UNIT = "unsigned char";

export function cTypedefs(textUnit: string): string {
  return [
    "#ifndef TERA_FN_DEFINED",
    "#define TERA_FN_DEFINED",
    `typedef void (*${C_CODE})(void);`,
    `typedef ${textUnit} ${C_CHAR};`,
    "#endif",
  ].join(String.fromCharCode(10));
}

export const C_CODE_TYPEDEF = cTypedefs(C_WIDE_TEXT_UNIT);

export type CScalarType =
  | typeof C_ANY_POINTER
  | typeof C_INT32
  | typeof C_DOUBLE
  | typeof C_STRING
  | typeof C_POINTER
  | typeof C_CODE
  | typeof C_VOID;

const C_BY_SCALAR = new Map<AotScalar, CScalarType>([
  [SCALAR_INT32, C_INT32],
  [SCALAR_FLOAT64, C_DOUBLE],
  [SCALAR_STRING, C_STRING],
  [SCALAR_POINTER, C_POINTER],
  [SCALAR_CODE, C_CODE],
  [SCALAR_VOID, C_VOID],
]);

const C_POINTER_TYPES: ReadonlySet<CScalarType> = new Set<CScalarType>([
  C_ANY_POINTER,
  ...[...C_BY_SCALAR].filter(([scalar]) => isReferenceScalar(scalar)).map(([, type]) => type),
]);

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
