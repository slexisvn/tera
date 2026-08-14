import {
  mkString,
  isObject,
  isUndefined,
  getPayload,
  toString,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";

type BuiltinMethod = {
  name: string;
  call(args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
};

function ownStringOr(thisValue: TaggedValue, key: string, fallback: string): string {
  if (!isObject(thisValue)) return fallback;
  const value = getPayload(thisValue).getProperty(key);
  return value === undefined || isUndefined(value) ? fallback : toString(value);
}

export const ERROR_METHODS = {
  toString: {
    name: "Error.prototype.toString",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const name = ownStringOr(thisValue, "name", "Error");
      const message = ownStringOr(thisValue, "message", "");
      if (name === "") return mkString(message);
      if (message === "") return mkString(name);
      return mkString(`${name}: ${message}`);
    },
  },
} as Record<string, BuiltinMethod>;
