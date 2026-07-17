import {
  mkSmi,
  mkBool,
  mkString,
  mkUndefined,
  mkArray,
  isFunction,
  isSmi,
  isUndefined,
  isArray,
  toBool,
  toDisplayString,
  toNumber,
  getPayload,
  strictEqual,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import { createJSArray } from "../../objects/heap/factory.js";

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

type RuntimeArray = {
  elements: Array<TaggedValue | undefined>;
  getLength(): number;
  getIndex(index: number): TaggedValue | undefined;
  setIndex(index: number, value: TaggedValue): void;
  push(...values: TaggedValue[]): number;
  pop(): TaggedValue | undefined;
  shift(): TaggedValue | undefined;
  unshift(...values: TaggedValue[]): number;
  splice(
    start: number,
    deleteCount?: number,
    ...items: TaggedValue[]
  ): Array<TaggedValue | undefined>;
  indexOf(value: TaggedValue, fromIndex?: number): number;
  includes(value: TaggedValue, fromIndex?: number): boolean;
  slice(start?: number, end?: number): RuntimeArray;
  join(separator?: string): string;
  reverse(): RuntimeArray;
  sort(compareFn?: (a: TaggedValue, b: TaggedValue) => number): RuntimeArray;
};

function runtimeArray(value: TaggedValue): RuntimeArray {
  return getPayload(value) as RuntimeArray;
}

function valueAt(arr: RuntimeArray, index: number): TaggedValue {
  const value = arr.getIndex(index);
  return value === undefined ? mkUndefined() : value;
}

function rawElement(arr: RuntimeArray, index: number): TaggedValue {
  const value = arr.elements[index];
  return value === undefined ? mkUndefined() : value;
}

function requireInterpreter(interpreter?: InterpreterLike): InterpreterLike {
  if (!interpreter) throw new Error("TypeError: interpreter is required");
  return interpreter;
}

export const ARRAY_METHODS = {
  push: {
    name: "Array.prototype.push",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      for (let i = 0; i < args.length; i++) {
        arr.push(args[i]);
      }
      return mkSmi(arr.getLength());
    },
  },

  pop: {
    name: "Array.prototype.pop",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const val = arr.pop();
      return val !== undefined ? val : mkUndefined();
    },
  },

  shift: {
    name: "Array.prototype.shift",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const val = arr.shift();
      return val !== undefined ? val : mkUndefined();
    },
  },

  unshift: {
    name: "Array.prototype.unshift",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      for (let i = args.length - 1; i >= 0; i--) {
        arr.unshift(args[i]);
      }
      return mkSmi(arr.getLength());
    },
  },

  splice: {
    name: "Array.prototype.splice",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const start = isSmi(args[0]) ? getPayload(args[0]) : 0;
      const deleteCount =
        args.length > 1 && isSmi(args[1]) ? getPayload(args[1]) : undefined;
      const items = args.slice(2);
      const removed = arr.splice(start, deleteCount, ...items);
      return mkArray(createJSArray(removed));
    },
  },

  indexOf: {
    name: "Array.prototype.indexOf",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const target = args[0] === undefined ? mkUndefined() : args[0];
      const fromIndex =
        args.length > 1 && isSmi(args[1]) ? getPayload(args[1]) : undefined;
      return mkSmi(arr.indexOf(target, fromIndex));
    },
  },

  lastIndexOf: {
    name: "Array.prototype.lastIndexOf",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const target = args[0] === undefined ? mkUndefined() : args[0];
      for (let i = arr.getLength() - 1; i >= 0; i--) {
        const el = valueAt(arr, i);
        if (strictEqual(el, target)) return mkSmi(i);
      }
      return mkSmi(-1);
    },
  },

  includes: {
    name: "Array.prototype.includes",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const target = args[0] === undefined ? mkUndefined() : args[0];
      const fromIndex =
        args.length > 1 && isSmi(args[1]) ? getPayload(args[1]) : undefined;
      return mkBool(arr.includes(target, fromIndex));
    },
  },

  find: {
    name: "Array.prototype.find",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      for (let i = 0; i < arr.getLength(); i++) {
        const elem = valueAt(arr, i);
        const result = runner.callFunctionValue(
          callback,
          [elem, mkSmi(i)],
          mkUndefined(),
        );
        if (toBool(result)) return elem;
      }
      return mkUndefined();
    },
  },

  findLast: {
    name: "Array.prototype.findLast",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      for (let i = arr.getLength() - 1; i >= 0; i--) {
        const elem = valueAt(arr, i);
        if (toBool(runner.callFunctionValue(callback, [elem, mkSmi(i)], mkUndefined())))
          return elem;
      }
      return mkUndefined();
    },
  },

  findLastIndex: {
    name: "Array.prototype.findLastIndex",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      for (let i = arr.getLength() - 1; i >= 0; i--) {
        const elem = valueAt(arr, i);
        if (toBool(runner.callFunctionValue(callback, [elem, mkSmi(i)], mkUndefined())))
          return mkSmi(i);
      }
      return mkSmi(-1);
    },
  },

  reduceRight: {
    name: "Array.prototype.reduceRight",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      let acc: TaggedValue;
      let i = arr.getLength() - 1;
      if (args.length > 1) {
        acc = args[1];
      } else {
        if (arr.getLength() === 0)
          throw new Error("TypeError: Reduce of empty array with no initial value");
        acc = valueAt(arr, i);
        i--;
      }
      for (; i >= 0; i--) {
        const elem = valueAt(arr, i);
        acc = runner.callFunctionValue(callback, [acc, elem, mkSmi(i)], mkUndefined());
      }
      return acc;
    },
  },

  copyWithin: {
    name: "Array.prototype.copyWithin",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const len = arr.getLength();
      const rel = (v: TaggedValue | undefined, d: number): number => {
        if (v === undefined) return d;
        let n = Math.trunc(toNumber(v));
        if (n < 0) n = Math.max(len + n, 0);
        else n = Math.min(n, len);
        return n;
      };
      let target = rel(args[0], 0);
      let start = rel(args[1], 0);
      let end = args.length > 2 ? rel(args[2], len) : len;
      const snapshot: Array<TaggedValue | undefined> = [];
      for (let i = start; i < end; i++) snapshot.push(arr.getIndex(i));
      for (let k = 0; k < snapshot.length && target + k < len; k++) {
        const v = snapshot[k];
        arr.setIndex(target + k, v === undefined ? mkUndefined() : v);
      }
      return thisValue;
    },
  },

  findIndex: {
    name: "Array.prototype.findIndex",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      for (let i = 0; i < arr.getLength(); i++) {
        const elem = valueAt(arr, i);
        const result = runner.callFunctionValue(
          callback,
          [elem, mkSmi(i)],
          mkUndefined(),
        );
        if (toBool(result)) return mkSmi(i);
      }
      return mkSmi(-1);
    },
  },

  forEach: {
    name: "Array.prototype.forEach",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      for (let i = 0; i < arr.getLength(); i++) {
        const elem = valueAt(arr, i);
        runner.callFunctionValue(
          callback,
          [elem, mkSmi(i)],
          mkUndefined(),
        );
      }
      return mkUndefined();
    },
  },

  map: {
    name: "Array.prototype.map",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      const result: TaggedValue[] = [];
      for (let i = 0; i < arr.getLength(); i++) {
        const elem = valueAt(arr, i);
        result.push(
          runner.callFunctionValue(
            callback,
            [elem, mkSmi(i)],
            mkUndefined(),
          ),
        );
      }
      return mkArray(createJSArray(result));
    },
  },

  filter: {
    name: "Array.prototype.filter",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      const result: TaggedValue[] = [];
      for (let i = 0; i < arr.getLength(); i++) {
        const elem = valueAt(arr, i);
        const keep = runner.callFunctionValue(
          callback,
          [elem, mkSmi(i)],
          mkUndefined(),
        );
        if (toBool(keep)) result.push(elem);
      }
      return mkArray(createJSArray(result));
    },
  },

  reduce: {
    name: "Array.prototype.reduce",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      const runner = requireInterpreter(interpreter);
      const callback = args[0];
      if (!isFunction(callback))
        throw new Error("TypeError: callback is not a function");
      let accumulator: TaggedValue;
      let startIndex: number;
      if (args.length > 1) {
        accumulator = args[1];
        startIndex = 0;
      } else {
        if (arr.getLength() === 0)
          throw new Error(
            "TypeError: Reduce of empty array with no initial value",
          );
        accumulator = valueAt(arr, 0);
        startIndex = 1;
      }
      for (let i = startIndex; i < arr.getLength(); i++) {
        const elem = valueAt(arr, i);
        accumulator = runner.callFunctionValue(
          callback,
          [accumulator, elem, mkSmi(i)],
          mkUndefined(),
        );
      }
      return accumulator;
    },
  },

  concat: {
    name: "Array.prototype.concat",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const elements = [...arr.elements];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (isArray(arg)) {
          const otherArr = runtimeArray(arg);
          for (let j = 0; j < otherArr.getLength(); j++) {
            elements.push(otherArr.getIndex(j));
          }
        } else {
          elements.push(arg);
        }
      }
      return mkArray(createJSArray(elements));
    },
  },

  slice: {
    name: "Array.prototype.slice",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const start =
        args.length > 0 && isSmi(args[0]) ? getPayload(args[0]) : undefined;
      const end =
        args.length > 1 && isSmi(args[1]) ? getPayload(args[1]) : undefined;
      const sliced = arr.slice(start, end);
      return mkArray(createJSArray(sliced.elements));
    },
  },

  join: {
    name: "Array.prototype.join",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const sep =
        args.length > 0 && !isUndefined(args[0])
          ? toDisplayString(args[0])
          : undefined;
      return mkString(arr.join(sep));
    },
  },

  reverse: {
    name: "Array.prototype.reverse",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      runtimeArray(thisValue).reverse();
      return thisValue;
    },
  },

  sort: {
    name: "Array.prototype.sort",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      if (args.length > 0 && isFunction(args[0])) {
        const runner = requireInterpreter(interpreter);
        const compareFn = args[0];
        arr.sort((a: TaggedValue, b: TaggedValue) => {
          const result = runner.callFunctionValue(
            compareFn,
            [a, b],
            mkUndefined(),
          );
          return toNumber(result);
        });
      } else {
        arr.sort();
      }
      return thisValue;
    },
  },

  flat: {
    name: "Array.prototype.flat",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      const depth = args.length > 0 ? toNumber(args[0]!) : 1;
      function flattenInto(source: RuntimeArray, d: number): TaggedValue[] {
        const result: TaggedValue[] = [];
        for (let i = 0; i < source.getLength(); i++) {
          const el = source.elements[i];
          if (el !== undefined && d > 0 && isArray(el)) {
            result.push(...flattenInto(runtimeArray(el), d - 1));
          } else {
            result.push(el !== undefined ? el : mkUndefined());
          }
        }
        return result;
      }
      return mkArray(createJSArray(flattenInto(arr, depth)));
    },
  },

  flatMap: {
    name: "Array.prototype.flatMap",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      if (args.length === 0 || !isFunction(args[0])) return thisValue;
      const runner = requireInterpreter(interpreter);
      const fn = args[0]!;
      const result: TaggedValue[] = [];
      for (let i = 0; i < arr.getLength(); i++) {
        const el = rawElement(arr, i);
        const mapped = runner.callFunctionValue(
          fn,
          [el, mkSmi(i), thisValue],
          mkUndefined(),
        );
        if (isArray(mapped)) {
          const inner = runtimeArray(mapped);
          for (let j = 0; j < inner.getLength(); j++) {
            result.push(
              rawElement(inner, j),
            );
          }
        } else {
          result.push(mapped);
        }
      }
      return mkArray(createJSArray(result));
    },
  },

  at: {
    name: "Array.prototype.at",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      if (args.length === 0) return mkUndefined();
      let idx = toNumber(args[0]!) | 0;
      if (idx < 0) idx = arr.getLength() + idx;
      if (idx < 0 || idx >= arr.getLength()) return mkUndefined();
      return rawElement(arr, idx);
    },
  },

  fill: {
    name: "Array.prototype.fill",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const arr = runtimeArray(thisValue);
      if (args.length === 0) return thisValue;
      const value = args[0];
      const len = arr.getLength();
      let start = args.length > 1 ? toNumber(args[1]) | 0 : 0;
      let end = args.length > 2 ? toNumber(args[2]) | 0 : len;
      if (start < 0) start = Math.max(0, len + start);
      if (end < 0) end = Math.max(0, len + end);
      for (let i = start; i < end && i < len; i++) {
        arr.elements[i] = value;
      }
      return thisValue;
    },
  },

  every: {
    name: "Array.prototype.every",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      if (args.length === 0 || !isFunction(args[0])) return mkBool(true);
      const runner = requireInterpreter(interpreter);
      const fn = args[0]!;
      for (let i = 0; i < arr.getLength(); i++) {
        const el = rawElement(arr, i);
        const result = runner.callFunctionValue(
          fn,
          [el, mkSmi(i), thisValue],
          mkUndefined(),
        );
        if (!toBool(result)) return mkBool(false);
      }
      return mkBool(true);
    },
  },

  some: {
    name: "Array.prototype.some",
    call(
      args: TaggedValue[],
      thisValue: TaggedValue,
      interpreter?: InterpreterLike,
    ) {
      const arr = runtimeArray(thisValue);
      if (args.length === 0 || !isFunction(args[0])) return mkBool(false);
      const runner = requireInterpreter(interpreter);
      const fn = args[0]!;
      for (let i = 0; i < arr.getLength(); i++) {
        const el = rawElement(arr, i);
        const result = runner.callFunctionValue(
          fn,
          [el, mkSmi(i), thisValue],
          mkUndefined(),
        );
        if (toBool(result)) return mkBool(true);
      }
      return mkBool(false);
    },
  },
} satisfies Record<string, BuiltinMethod>;
