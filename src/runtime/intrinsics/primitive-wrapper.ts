import { isObject, getPayload } from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";

type PrimitiveWrapper = {
  _primitiveValue?: TaggedValue;
};

export function unwrapPrimitive<T>(
  thisValue: TaggedValue,
  guard: (v: TaggedValue) => boolean,
  extract: (v: TaggedValue) => T,
  coerce: (v: TaggedValue) => T,
): T {
  if (guard(thisValue)) return extract(thisValue);
  if (isObject(thisValue)) {
    const obj = getPayload(thisValue) as PrimitiveWrapper;
    if (obj._primitiveValue !== undefined && guard(obj._primitiveValue))
      return extract(obj._primitiveValue);
  }
  return coerce(thisValue);
}

export function unwrapPrimitiveTagged(
  thisValue: TaggedValue,
  guard: (v: TaggedValue) => boolean,
): TaggedValue {
  if (guard(thisValue)) return thisValue;
  if (isObject(thisValue)) {
    const obj = getPayload(thisValue) as PrimitiveWrapper;
    if (obj._primitiveValue !== undefined && guard(obj._primitiveValue))
      return obj._primitiveValue;
  }
  return thisValue;
}
