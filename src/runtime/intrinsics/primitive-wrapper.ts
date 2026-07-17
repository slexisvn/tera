import { isObject, getPayload } from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";

type PrimitiveWrapper = {
  _primitiveValue?: TaggedValue;
};

/**
 * Value-returning half of the primitive-wrapper unwrap pair.
 * If `thisValue` is the primitive itself (per `guard`), returns `extract(thisValue)`.
 * If it is a wrapper object whose `_primitiveValue` matches `guard`, returns
 * `extract` of that inner value. Otherwise falls back to `coerce(thisValue)`.
 */
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

/**
 * Tagged-value-returning half of the primitive-wrapper unwrap pair.
 * Returns the primitive `TaggedValue` (either `thisValue` itself or the wrapper's
 * `_primitiveValue`), otherwise returns `thisValue` unchanged.
 */
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
