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
