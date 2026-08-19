export const REP_INT32 = "int32";
export const REP_FLOAT64 = "float64";
export const REP_TAGGED_NUMBER = "tagged-number";
export const REP_HANDLE = "handle";
export const REP_TAGGED = "tagged";
export const REP_BOOL = "bool";

export type Representation =
  | typeof REP_INT32
  | typeof REP_FLOAT64
  | typeof REP_TAGGED_NUMBER
  | typeof REP_HANDLE
  | typeof REP_TAGGED
  | typeof REP_BOOL;

const REPRESENTATIONS = new Set<string>([
  REP_INT32,
  REP_FLOAT64,
  REP_TAGGED_NUMBER,
  REP_HANDLE,
  REP_TAGGED,
  REP_BOOL,
]);

export function representationFrom(stamped: unknown): Representation {
  return typeof stamped === "string" && REPRESENTATIONS.has(stamped)
    ? (stamped as Representation)
    : REP_HANDLE;
}

export type AbiRepresentation =
  | typeof REP_HANDLE
  | typeof REP_BOOL
  | typeof REP_TAGGED_NUMBER;

export function abiRepresentationOf(rep: Representation): AbiRepresentation {
  if (rep === REP_HANDLE) return REP_HANDLE;
  if (rep === REP_BOOL) return REP_BOOL;
  return REP_TAGGED_NUMBER;
}
