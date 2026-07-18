import { getPayload, isString, type TaggedValue } from "../core/value/index.js";
import { runtimeOwnKeys, type InterpreterLike } from "../objects/exotic/proxy-ops.js";

export function forInKeys(
  value: TaggedValue,
  interpreter: InterpreterLike | null = null,
): string[] {
  if (!isString(value)) return runtimeOwnKeys(value, interpreter);

  const { length } = getPayload(value);
  const keys: string[] = new Array(length);
  for (let index = 0; index < length; index++) keys[index] = String(index);
  return keys;
}
