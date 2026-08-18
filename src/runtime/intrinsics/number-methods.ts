import {
  mkString,
  isNumber,
  toNumber,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import { integerArg } from "./builtin-method.js";
import type { BuiltinMethod } from "./builtin-method.js";
import {
  unwrapPrimitive,
  unwrapPrimitiveTagged,
} from "./primitive-wrapper.js";

function unwrapNumber(thisValue: TaggedValue): number {
  return unwrapPrimitive(thisValue, isNumber, toNumber, toNumber);
}

function unwrapNumberTagged(thisValue: TaggedValue): TaggedValue {
  return unwrapPrimitiveTagged(thisValue, isNumber);
}

export const NUMBER_METHODS = {
  toString: {
    name: "Number.prototype.toString",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const num = unwrapNumber(thisValue);
      const radix =
        args.length > 0 && isNumber(args[0]) ? toNumber(args[0]) : 10;
      return mkString(num.toString(radix));
    },
  },

  toFixed: {
    name: "Number.prototype.toFixed",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const num = unwrapNumber(thisValue);
      return mkString(num.toFixed(integerArg(args, 0, 0)));
    },
  },

  valueOf: {
    name: "Number.prototype.valueOf",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return unwrapNumberTagged(thisValue);
    },
  },

  toPrecision: {
    name: "Number.prototype.toPrecision",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const num = unwrapNumber(thisValue);
      return mkString(num.toPrecision(integerArg(args, 0, undefined)));
    },
  },

  toExponential: {
    name: "Number.prototype.toExponential",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const num = unwrapNumber(thisValue);
      return mkString(num.toExponential(integerArg(args, 0, undefined)));
    },
  },
} satisfies Record<string, BuiltinMethod>;
