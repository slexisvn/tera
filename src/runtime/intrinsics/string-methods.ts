import {
  mkSmi,
  mkNumber,
  mkBool,
  mkString,
  mkUndefined,
  mkArray,
  mkNull,
  isSmi,
  isDouble,
  isString,
  isUndefined,
  isFunction,
  isRegex,
  getPayload,
  toNumber,
  toDisplayString,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import { createJSArray } from "../../objects/heap/factory.js";
import { unwrapPrimitive } from "./primitive-wrapper.js";

type InterpreterLike = {
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
};

type BuiltinMethod = {
  name: string;
  call(
    args: TaggedValue[],
    thisValue: TaggedValue,
    interpreter?: InterpreterLike,
  ): TaggedValue;
};

type RegexPayload = {
  nativeRegex: RegExp;
  lastIndex?: number;
};

function regexPayload(value: TaggedValue): RegexPayload {
  return getPayload(value) as RegexPayload;
}

function unwrapString(thisValue: TaggedValue): string {
  return unwrapPrimitive(
    thisValue,
    isString,
    (v) => getPayload(v) as string,
    toDisplayString,
  );
}

export const STRING_METHODS = {
  charAt: {
    name: "String.prototype.charAt",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const idx = args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : 0;
      return mkString(str.charAt(idx));
    },
  },

  charCodeAt: {
    name: "String.prototype.charCodeAt",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const idx = args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : 0;
      const code = str.charCodeAt(idx);
      return Number.isNaN(code) ? mkNumber(NaN) : mkSmi(code);
    },
  },

  codePointAt: {
    name: "String.prototype.codePointAt",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const idx =
        args.length > 0 && (isSmi(args[0]) || isDouble(args[0]))
          ? Math.trunc(getPayload(args[0]))
          : 0;
      const cp = str.codePointAt(idx);
      return cp === undefined ? mkUndefined() : mkSmi(cp);
    },
  },

  substring: {
    name: "String.prototype.substring",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const start = args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : 0;
      const end =
        args.length > 1 && isSmi(args[1]) ? getPayload(args[1]) : undefined;
      return mkString(str.substring(start, end));
    },
  },

  substr: {
    name: "String.prototype.substr",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const len = str.length;
      let start =
        args.length > 0 && (isSmi(args[0]) || isDouble(args[0]))
          ? Math.trunc(getPayload(args[0]))
          : 0;
      if (start < 0) start = Math.max(len + start, 0);
      const length =
        args.length > 1 && (isSmi(args[1]) || isDouble(args[1]))
          ? Math.trunc(getPayload(args[1]))
          : len - start;
      if (length <= 0) return mkString("");
      return mkString(str.substr(start, length));
    },
  },

  slice: {
    name: "String.prototype.slice",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const start = args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : 0;
      const end =
        args.length > 1 && isSmi(args[1]) ? getPayload(args[1]) : undefined;
      return mkString(str.slice(start, end));
    },
  },

  indexOf: {
    name: "String.prototype.indexOf",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const search =
        args.length > 0 && isString(args[0]) ? getPayload(args[0]) : "";
      const fromIndex =
        args.length > 1 && isSmi(args[1]) ? getPayload(args[1]) : undefined;
      return mkSmi(str.indexOf(search, fromIndex));
    },
  },

  lastIndexOf: {
    name: "String.prototype.lastIndexOf",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const search =
        args.length > 0 && isString(args[0]) ? getPayload(args[0]) : "";
      const fromIndex =
        args.length > 1 && isSmi(args[1]) ? getPayload(args[1]) : undefined;
      return mkSmi(str.lastIndexOf(search, fromIndex));
    },
  },

  includes: {
    name: "String.prototype.includes",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const search =
        args.length > 0 && isString(args[0]) ? getPayload(args[0]) : "";
      return mkBool(str.includes(search));
    },
  },

  startsWith: {
    name: "String.prototype.startsWith",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const search =
        args.length > 0 && isString(args[0]) ? getPayload(args[0]) : "";
      return mkBool(str.startsWith(search));
    },
  },

  endsWith: {
    name: "String.prototype.endsWith",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const search =
        args.length > 0 && isString(args[0]) ? getPayload(args[0]) : "";
      return mkBool(str.endsWith(search));
    },
  },

  split: {
    name: "String.prototype.split",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      let sep: string | RegExp | undefined;
      if (args.length > 0 && isRegex(args[0])) {
        sep = regexPayload(args[0]).nativeRegex;
      } else {
        sep =
          args.length > 0 && isString(args[0])
            ? (getPayload(args[0]) as string)
            : undefined;
      }
      const parts = sep === undefined ? [str] : str.split(sep);
      return mkArray(createJSArray(parts.map((p: string) => mkString(p))));
    },
  },

  replace: {
    name: "String.prototype.replace",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const str = unwrapString(thisValue);
      let search: string | RegExp;
      if (args.length > 0 && isRegex(args[0])) {
        search = regexPayload(args[0]).nativeRegex;
      } else {
        search =
          args.length > 0 && isString(args[0])
            ? (getPayload(args[0]) as string)
            : "";
      }
      if (args.length > 1 && isFunction(args[1]) && interpreter) {
        const replacer = args[1];
        const result = str.replace(search, (match: string, ...rest: RuntimeValue[]) => {
          const cbArgs: TaggedValue[] = [mkString(match)];
          let tail = rest;
          if (tail.length >= 2) {
            const groups = tail.slice(0, tail.length - 2);
            const offset = Number(tail[tail.length - 2]);
            const fullStr = String(tail[tail.length - 1]);
            for (const g of groups) {
              cbArgs.push(g !== undefined ? mkString(String(g)) : mkUndefined());
            }
            cbArgs.push(mkSmi(offset));
            cbArgs.push(mkString(fullStr));
          }
          const callResult = interpreter.callFunctionValue(
            replacer,
            cbArgs,
            mkUndefined(),
          );
          return toDisplayString(callResult);
        });
        return mkString(result);
      }
      const replacement =
        args.length > 1 && isString(args[1])
          ? (getPayload(args[1]) as string)
          : "";
      return mkString(str.replace(search, replacement));
    },
  },

  match: {
    name: "String.prototype.match",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      if (args.length === 0) return mkNull();
      let regex: RegExp;
      if (isRegex(args[0])) {
        regex = regexPayload(args[0]).nativeRegex;
      } else {
        regex = new RegExp(
          isString(args[0])
            ? (getPayload(args[0]) as string)
            : toDisplayString(args[0]),
        );
      }
      const result = str.match(regex);
      if (result === null) return mkNull();
      return mkArray(
        createJSArray(
          result.map((m) => (m !== undefined ? mkString(m) : mkUndefined())),
        ),
      );
    },
  },

  matchAll: {
    name: "String.prototype.matchAll",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      let regex: RegExp;
      if (isRegex(args[0])) {
        regex = regexPayload(args[0]).nativeRegex;
      } else {
        regex = new RegExp(
          isString(args[0])
            ? (getPayload(args[0]) as string)
            : toDisplayString(args[0]),
        );
      }
      if (!regex.flags.includes("g")) {
        regex = new RegExp(regex.source, regex.flags + "g");
      }
      const out = [];
      for (const m of str.matchAll(regex)) {
        out.push(
          mkArray(
            createJSArray(
              m.map((x: string | undefined) =>
                x !== undefined ? mkString(x) : mkUndefined(),
              ),
            ),
          ),
        );
      }
      return mkArray(createJSArray(out));
    },
  },

  search: {
    name: "String.prototype.search",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      if (args.length === 0) return mkSmi(-1);
      let regex: RegExp;
      if (isRegex(args[0])) {
        regex = regexPayload(args[0]).nativeRegex;
      } else {
        regex = new RegExp(
          isString(args[0])
            ? (getPayload(args[0]) as string)
            : toDisplayString(args[0]),
        );
      }
      return mkSmi(str.search(regex));
    },
  },

  trim: {
    name: "String.prototype.trim",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return mkString(unwrapString(thisValue).trim());
    },
  },

  trimStart: {
    name: "String.prototype.trimStart",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return mkString(unwrapString(thisValue).trimStart());
    },
  },

  trimEnd: {
    name: "String.prototype.trimEnd",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return mkString(unwrapString(thisValue).trimEnd());
    },
  },

  toLowerCase: {
    name: "String.prototype.toLowerCase",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return mkString(unwrapString(thisValue).toLowerCase());
    },
  },

  toUpperCase: {
    name: "String.prototype.toUpperCase",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return mkString(unwrapString(thisValue).toUpperCase());
    },
  },

  repeat: {
    name: "String.prototype.repeat",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const count = args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : 0;
      return mkString(str.repeat(count));
    },
  },

  padStart: {
    name: "String.prototype.padStart",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const targetLen =
        args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : 0;
      const padStr =
        args.length > 1 && isString(args[1])
          ? (getPayload(args[1]) as string)
          : undefined;
      return mkString(str.padStart(targetLen, padStr));
    },
  },

  padEnd: {
    name: "String.prototype.padEnd",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      const targetLen =
        args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : 0;
      const padStr =
        args.length > 1 && isString(args[1])
          ? (getPayload(args[1]) as string)
          : undefined;
      return mkString(str.padEnd(targetLen, padStr));
    },
  },

  concat: {
    name: "String.prototype.concat",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      let result = unwrapString(thisValue);
      for (let i = 0; i < args.length; i++) {
        result += isString(args[i])
          ? (getPayload(args[i]) as string)
          : toDisplayString(args[i]);
      }
      return mkString(result);
    },
  },

  replaceAll: {
    name: "String.prototype.replaceAll",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const str = unwrapString(thisValue);
      if (args.length === 0) return thisValue;
      const search = args[0];
      const replacement = args.length > 1 ? args[1] : mkUndefined();
      if (isRegex(search)) {
        const regex = regexPayload(search).nativeRegex;
        const globalRegex = regex.global
          ? regex
          : new RegExp(regex.source, regex.flags + "g");
        if (isFunction(replacement) && interpreter) {
          return mkString(
            str.replace(globalRegex, (...m) => {
              const callArgs = m
                .slice(0, -2)
                .map((v: string | undefined) =>
                  v === undefined ? mkUndefined() : mkString(v),
                );
              return toDisplayString(
                interpreter.callFunctionValue(
                  replacement,
                  callArgs,
                  mkUndefined(),
                ),
              );
            }),
          );
        }
        const repStr = isUndefined(replacement)
          ? "undefined"
          : toDisplayString(replacement);
        return mkString(str.replace(globalRegex, repStr));
      }
      const searchStr = toDisplayString(search);
      const repStr = isUndefined(replacement)
        ? "undefined"
        : toDisplayString(replacement);
      return mkString(str.split(searchStr).join(repStr));
    },
  },

  at: {
    name: "String.prototype.at",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const str = unwrapString(thisValue);
      if (args.length === 0) return mkUndefined();
      let idx = toNumber(args[0]) | 0;
      if (idx < 0) idx = str.length + idx;
      if (idx < 0 || idx >= str.length) return mkUndefined();
      return mkString(str[idx]!);
    },
  },

  toString: {
    name: "String.prototype.toString",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return mkString(unwrapString(thisValue));
    },
  },

  valueOf: {
    name: "String.prototype.valueOf",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      return mkString(unwrapString(thisValue));
    },
  },
} satisfies Record<string, BuiltinMethod>;
