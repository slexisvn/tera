import { isUndefined, toIntegerOrInfinity } from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";

export type InterpreterLike = {
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
};

export type BuiltinMethod = {
  name: string;
  call(
    args: TaggedValue[],
    thisValue: TaggedValue,
    interpreter?: InterpreterLike,
  ): TaggedValue;
};

export function integerArg<T extends number | undefined>(
  args: TaggedValue[],
  index: number,
  absent: T,
): number | T {
  const value = args[index];
  return value === undefined || isUndefined(value)
    ? absent
    : toIntegerOrInfinity(value);
}
