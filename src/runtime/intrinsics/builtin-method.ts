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
