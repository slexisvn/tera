import {
  mkString,
  isSmi,
  isNumber,
  getPayload,
  toNumber,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import {
  unwrapPrimitive,
  unwrapPrimitiveTagged,
} from "./primitive-wrapper.js";

type BuiltinMethod = {
  name: string;
  call(args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
};

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
      const digits =
        args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : 0;
      return mkString(num.toFixed(digits));
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
      const precision =
        args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : undefined;
      return mkString(num.toPrecision(precision));
    },
  },

  toExponential: {
    name: "Number.prototype.toExponential",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const num = unwrapNumber(thisValue);
      const fractionDigits =
        args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : undefined;
      return mkString(num.toExponential(fractionDigits));
    },
  },
} as Record<string, BuiltinMethod>;
