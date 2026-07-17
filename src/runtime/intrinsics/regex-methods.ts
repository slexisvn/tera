import {
  mkBool,
  mkString,
  mkSmi,
  mkNull,
  mkArray,
  mkUndefined,
  getPayload,
  isString,
  toDisplayString,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import { createJSArray } from "../../objects/heap/factory.js";

type RegexRuntimeValue = {
  nativeRegex: RegExp;
  lastIndex: number;
};

type BuiltinMethod = {
  name: string;
  call(args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
};

function getRegexRuntimeValue(thisValue: TaggedValue): RegexRuntimeValue {
  return getPayload(thisValue) as RegexRuntimeValue;
}

export const REGEX_METHODS = {
  test: {
    name: "RegExp.prototype.test",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const rv = getRegexRuntimeValue(thisValue);
      const str = args.length > 0 ? toDisplayString(args[0]) : "";
      rv.nativeRegex.lastIndex = rv.lastIndex;
      const result = rv.nativeRegex.test(str);
      rv.lastIndex = rv.nativeRegex.lastIndex;
      return mkBool(result);
    },
  },

  exec: {
    name: "RegExp.prototype.exec",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const rv = getRegexRuntimeValue(thisValue);
      const str = args.length > 0 ? toDisplayString(args[0]) : "";
      rv.nativeRegex.lastIndex = rv.lastIndex;
      const result = rv.nativeRegex.exec(str);
      rv.lastIndex = rv.nativeRegex.lastIndex;
      if (result === null) return mkNull();
      const elements: TaggedValue[] = [];
      for (let i = 0; i < result.length; i++) {
        elements.push(
          result[i] !== undefined ? mkString(result[i]) : mkUndefined(),
        );
      }
      return mkArray(createJSArray(elements));
    },
  },

  toString: {
    name: "RegExp.prototype.toString",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const rv = getRegexRuntimeValue(thisValue);
      return mkString("/" + rv.nativeRegex.source + "/" + rv.nativeRegex.flags);
    },
  },
} as Record<string, BuiltinMethod>;

const REGEX_FLAG_PROPS = new Set([
  "global",
  "ignoreCase",
  "multiline",
  "dotAll",
  "sticky",
  "unicode",
]);

export function getRegexProperty(name: string, rv: RegexRuntimeValue): TaggedValue | null {
  switch (name) {
    case "source":
      return mkString(rv.nativeRegex.source);
    case "flags":
      return mkString(rv.nativeRegex.flags);
    case "lastIndex":
      return mkSmi(rv.lastIndex);
  }
  if (REGEX_FLAG_PROPS.has(name)) {
    return mkBool(Boolean(rv.nativeRegex[name as keyof RegExp]));
  }
  return null;
}
