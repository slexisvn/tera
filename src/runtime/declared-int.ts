import {
  getPayload,
  isDouble,
  isSmi,
  mkNumber,
  type TaggedValue,
} from "../core/value/index.js";
import type { DeclaredSignature } from "../optimizing/types/signature.js";

const DECLARED_INT_TYPE = "int";

export interface DeclaredIntCarrier {
  declaredSignature: DeclaredSignature | null;
  declaredInt32Return?: boolean;
}

export function declaredInt32Return(carrier: DeclaredIntCarrier): boolean {
  const known = carrier.declaredInt32Return;
  if (known !== undefined) return known;
  const declared = carrier.declaredSignature?.returns === DECLARED_INT_TYPE;
  carrier.declaredInt32Return = declared;
  return declared;
}

export function asDeclaredInt32(value: TaggedValue): TaggedValue {
  if (isSmi(value)) return value;
  if (!isDouble(value)) return value;
  const answered = getPayload(value);
  return Number.isInteger(answered) ? mkNumber(answered | 0) : value;
}
