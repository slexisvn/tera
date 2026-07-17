import { mkString, isBool, getPayload, toBool } from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import {
  unwrapPrimitive,
  unwrapPrimitiveTagged,
} from "./primitive-wrapper.js";

type BuiltinMethod = {
  name: string;
  call(args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
};

function unwrapBoolean(thisValue: TaggedValue): boolean {
  return unwrapPrimitive(
    thisValue,
    isBool,
    (v) => getPayload(v) as boolean,
    toBool,
  );
}

function unwrapBooleanTagged(thisValue: TaggedValue): TaggedValue {
  return unwrapPrimitiveTagged(thisValue, isBool);
}

export const BOOLEAN_METHODS = {
  toString: {
    name: "Boolean.prototype.toString",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return mkString(unwrapBoolean(thisValue) ? "true" : "false");
    },
  },

  valueOf: {
    name: "Boolean.prototype.valueOf",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return unwrapBooleanTagged(thisValue);
    },
  },
} as Record<string, BuiltinMethod>;
