import {
  mkUndefined,
  mkNumber,
  mkString,
  mkBool,
  mkDouble,
  mkSmi,
  mkNull,
  mkArray,
  mkObject,
  mkFunction,
  mkRegex,
  mkSymbol,
  toDisplayString,
  toString,
  isNumber,
  isSmi,
  isDouble,
  isString,
  isBool,
  isObject,
  isArray,
  isNull,
  isUndefined,
  isSymbol,
  isIterator,
  toNumber,
  toBool,
  getPayload,
  typeOf,
  isFunction,
  isGenerator,
  JSSymbol,
  symbolFor,
  symbolKeyFor,
  wellKnownSymbols,
  type TaggedValue,
  type GeneratorPayload,
} from "../../core/value/index.js";

import { createJSObject, createJSArray, createJSMap, createJSSet, createJSWeakMap } from "../../objects/heap/factory.js";
import type { CollectionObject } from "../../objects/heap/factory.js";
import {
  getIterator,
  iteratorDone,
  iteratorValue,
} from "../iteration/iterator.js";
import { AccessorPair } from "../../objects/heap/js-object.js";
import { tracer } from "../../core/tracing/index.js";
import { VMTypeError } from "../../core/errors/index.js";
import {
  createProxyValue,
  keysArray,
  proxyTargetIsValid,
  runtimeDefineProperty,
  runtimeGetOwnPropertyDescriptor,
  runtimeGetProperty,
  runtimeOwnKeys,
  runtimeSetProperty,
  runtimeHasProperty,
  runtimeDeleteProperty,
} from "../../objects/exotic/proxy-ops.js";
import { createDomainBuiltins } from "../domain/builtins.js";

type BuiltinArg = TaggedValue;
type BuiltinThis = {
  prototypeObj?: import("../../objects/heap/js-object.js").JSObject | null;
};
type BuiltinInterpreter = {
  jitEngine?: {
    output?: (text: string) => void;
  } | null;
  callFunctionValue(fn: TaggedValue, args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
  constructFunctionValue(fn: TaggedValue, args: TaggedValue[]): TaggedValue;
  generatorNext(gen: GeneratorPayload, value: TaggedValue): TaggedValue;
};
type JsonNativeObject = { [key: string]: JsonNativeValue };
type JsonNativeValue =
  | string
  | number
  | boolean
  | null
  | JsonNativeValue[]
  | JsonNativeObject;
type JsonReplacerValue = JsonNativeValue | undefined;
export function argOrUndefined(args: BuiltinArg[], index: number): TaggedValue {
  return args[index] === undefined ? mkUndefined() : args[index];
}

function extractArgNumber(args: BuiltinArg[], index: number, defaultVal: number) {
  if (index >= args.length) return defaultVal;
  const val = argOrUndefined(args, index);
  return toNumber(val);
}

function extractArgString(args: BuiltinArg[], index: number, defaultVal: string) {
  if (index >= args.length) return defaultVal;
  const val = argOrUndefined(args, index);
  return toDisplayString(val);
}

function buildErrorObject(name: string, args: BuiltinArg[]) {
  const obj = createJSObject();
  obj.setProperty("name", mkString(name));
  const message =
    args.length > 0 && !isUndefined(args[0])
      ? toDisplayString(args[0])
      : "";
  obj.setProperty("message", mkString(message));
  obj.setProperty("stack", mkString(message ? `${name}: ${message}` : name));
  obj.setProperty("__isError__", mkBool(true));
  obj.setProperty("constructor", mkFunction({ name, properties: {} }));
  return mkObject(obj);
}

function arrayConstruct(args: BuiltinArg[]) {
  if (args.length === 1 && isNumber(args[0])) {
    const len = getPayload(args[0]);
    if (Number.isInteger(len) && len >= 0) {
      const elements = new Array(len).fill(mkUndefined());
      return mkArray(createJSArray(elements));
    }
  }
  return mkArray(createJSArray(args.slice()));
}

function makeErrorBuiltin(name: string) {
  return {
    name,
    isErrorConstructor: true,
    call(args: BuiltinArg[]) {
      return buildErrorObject(name, args);
    },
    construct(args: BuiltinArg[]) {
      return buildErrorObject(name, args);
    },
  };
}

export const builtins = {
  ...createDomainBuiltins(),
  NaN: { globalConst: () => mkDouble(NaN) },
  Infinity: { globalConst: () => mkDouble(Infinity) },
  undefined: { globalConst: () => mkUndefined() },

  print: {
    name: "print",
    call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
      const output = args.map((a) => toDisplayString(a, undefined, args.length > 1)).join(" ");
      const target = interpreter?.jitEngine?.output;
      if (target) target(output);
      else console.log(output);
      return mkUndefined();
    },
  },

  console: {
    log: {
      name: "console.log",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        const output = args.map((a) => toDisplayString(a, undefined, args.length > 1)).join(" ");
        const target = interpreter?.jitEngine?.output;
        if (target) target(output);
        else console.log(output);
        return mkUndefined();
      },
    },
  },

  typeof: {
    name: "typeof",
    pure: true,
    call(args: BuiltinArg[]) {
      const v = args[0];
      if (!v) return mkString("undefined");
      return mkString(typeOf(v));
    },
  },

  parseInt: {
    name: "parseInt",
    pure: true,
    call(args: BuiltinArg[]) {
      const str = extractArgString(args, 0, "NaN");
      const radix = args.length > 1 ? extractArgNumber(args, 1, 10) : 10;
      const result = parseInt(str, radix);
      return mkNumber(result);
    },
  },

  parseFloat: {
    name: "parseFloat",
    pure: true,
    call(args: BuiltinArg[]) {
      const str = extractArgString(args, 0, "NaN");
      const result = parseFloat(str);
      return mkNumber(result);
    },
  },

  isNaN: {
    name: "isNaN",
    pure: true,
    call(args: BuiltinArg[]) {
      const v = (args[0] === undefined ? mkUndefined() : args[0]);
      return mkBool(Number.isNaN(toNumber(v)));
    },
  },

  isFinite: {
    name: "isFinite",
    pure: true,
    call(args: BuiltinArg[]) {
      const v = (args[0] === undefined ? mkUndefined() : args[0]);
      return mkBool(Number.isFinite(toNumber(v)));
    },
  },

  Number: {
    name: "Number",
    pure: true,
    call(args: BuiltinArg[]) {
      if (args.length === 0) return mkSmi(0);
      return mkNumber(toNumber(args[0]));
    },
    MAX_SAFE_INTEGER: 9007199254740991,
    MIN_SAFE_INTEGER: -9007199254740991,
    MAX_VALUE: Number.MAX_VALUE,
    MIN_VALUE: Number.MIN_VALUE,
    EPSILON: Number.EPSILON,
    POSITIVE_INFINITY: Infinity,
    NEGATIVE_INFINITY: -Infinity,
    NaN: NaN,
    isInteger: {
      name: "Number.isInteger",
      pure: true,
      call(args: BuiltinArg[]) {
        return mkBool(
          args.length > 0 && isNumber(args[0]) && Number.isInteger(getPayload(args[0])),
        );
      },
    },
    isSafeInteger: {
      name: "Number.isSafeInteger",
      pure: true,
      call(args: BuiltinArg[]) {
        return mkBool(
          args.length > 0 && isNumber(args[0]) && Number.isSafeInteger(getPayload(args[0])),
        );
      },
    },
    isFinite: {
      name: "Number.isFinite",
      pure: true,
      call(args: BuiltinArg[]) {
        return mkBool(
          args.length > 0 && isNumber(args[0]) && Number.isFinite(getPayload(args[0])),
        );
      },
    },
    isNaN: {
      name: "Number.isNaN",
      pure: true,
      call(args: BuiltinArg[]) {
        return mkBool(
          args.length > 0 && isNumber(args[0]) && Number.isNaN(getPayload(args[0])),
        );
      },
    },
    parseFloat: {
      name: "Number.parseFloat",
      pure: true,
      call(args: BuiltinArg[]) {
        return mkNumber(parseFloat(extractArgString(args, 0, "NaN")));
      },
    },
    parseInt: {
      name: "Number.parseInt",
      pure: true,
      call(args: BuiltinArg[]) {
        const radix = args.length > 1 ? extractArgNumber(args, 1, 10) : 10;
        return mkNumber(parseInt(extractArgString(args, 0, "NaN"), radix));
      },
    },
  },

  Boolean: {
    name: "Boolean",
    pure: true,
    call(args: BuiltinArg[]) {
      if (args.length === 0) return mkBool(false);
      return mkBool(toBool(args[0]));
    },
  },

  RegExp: {
    name: "RegExp",
    call(args: BuiltinArg[]) {
      const pattern = args.length > 0 ? toDisplayString(args[0]) : "";
      const flags = args.length > 1 ? toDisplayString(args[1]) : "";
      return mkRegex(new RegExp(pattern, flags));
    },
    construct(args: BuiltinArg[]) {
      const pattern = args.length > 0 ? toDisplayString(args[0]) : "";
      const flags = args.length > 1 ? toDisplayString(args[1]) : "";
      return mkRegex(new RegExp(pattern, flags));
    },
  },

  Symbol: {
    name: "Symbol",
    call(args: BuiltinArg[]) {
      const desc =
        args.length > 0 && !isUndefined(args[0])
          ? toDisplayString(args[0])
          : undefined;
      return mkSymbol(new JSSymbol(desc));
    },
    for: {
      name: "Symbol.for",
      call(args: BuiltinArg[]) {
        const key = args.length > 0 ? toDisplayString(args[0]) : "undefined";
        return symbolFor(key);
      },
    },
    keyFor: {
      name: "Symbol.keyFor",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isSymbol(args[0])) return mkUndefined();
        const key = symbolKeyFor(args[0]);
        return key !== undefined ? mkString(key) : mkUndefined();
      },
    },
  },

  Proxy: {
    name: "Proxy",
    construct(args: BuiltinArg[]) {
      const target = args[0];
      const handler = args[1];
      if (!proxyTargetIsValid(target) || !proxyTargetIsValid(handler)) {
        throw new VMTypeError("Proxy target and handler must be objects");
      }
      return createProxyValue(target, handler);
    },
  },

  Error: makeErrorBuiltin("Error"),
  TypeError: makeErrorBuiltin("TypeError"),
  RangeError: makeErrorBuiltin("RangeError"),
  ReferenceError: makeErrorBuiltin("ReferenceError"),
  SyntaxError: makeErrorBuiltin("SyntaxError"),
  EvalError: makeErrorBuiltin("EvalError"),
  URIError: makeErrorBuiltin("URIError"),

  Map: {
    name: "Map",
    construct(this: BuiltinThis, args: BuiltinArg[], interpreter: BuiltinInterpreter) {
      const obj: CollectionObject = createJSMap();
      const data = obj._mapData;
      if (!data) throw new VMTypeError("Map storage is not initialized");
      if (this.prototypeObj) obj.setPrototype(this.prototypeObj);
      if (args.length > 0 && !isNull(args[0]) && !isUndefined(args[0])) {
        const iterable = args[0];
        if (isArray(iterable)) {
          const arr = getPayload(iterable);
          for (let i = 0; i < arr.getLength(); i++) {
            const entry = arr.getIndex(i);
            if (isArray(entry)) {
              const pair = getPayload(entry);
              const key = pair.getIndex(0) ?? mkUndefined();
              const val = pair.getIndex(1) ?? mkUndefined();
              data.set(key, val);
            }
          }
        }
      }
      return mkObject(obj);
    },
  },

  Set: {
    name: "Set",
    construct(this: BuiltinThis, args: BuiltinArg[], interpreter: BuiltinInterpreter) {
      const obj: CollectionObject = createJSSet();
      const data = obj._setData;
      if (!data) throw new VMTypeError("Set storage is not initialized");
      if (this.prototypeObj) obj.setPrototype(this.prototypeObj);
      if (args.length > 0 && !isNull(args[0]) && !isUndefined(args[0])) {
        const iterable = args[0];
        if (isArray(iterable)) {
          const arr = getPayload(iterable);
          for (let i = 0; i < arr.getLength(); i++) {
            data.add(arr.getIndex(i) ?? mkUndefined());
          }
        }
      }
      return mkObject(obj);
    },
  },

  WeakMap: {
    name: "WeakMap",
    construct(this: BuiltinThis, args: BuiltinArg[], interpreter: BuiltinInterpreter) {
      const obj: CollectionObject = createJSWeakMap();
      const data = obj._weakMapData;
      if (!data) throw new VMTypeError("WeakMap storage is not initialized");
      if (this.prototypeObj) obj.setPrototype(this.prototypeObj);
      if (args.length > 0 && !isNull(args[0]) && !isUndefined(args[0])) {
        const iterable = args[0];
        if (isArray(iterable)) {
          const arr = getPayload(iterable);
          for (let i = 0; i < arr.getLength(); i++) {
            const entry = arr.getIndex(i);
            if (isArray(entry)) {
              const pair = getPayload(entry);
              const key = pair.getIndex(0) ?? mkUndefined();
              if (!isObject(key)) throw new VMTypeError("Invalid value used as weak map key");
              data.set(key, pair.getIndex(1) ?? mkUndefined());
            }
          }
        }
      }
      return mkObject(obj);
    },
  },

  Math: {
    abs: {
      name: "Math.abs",
      pure: true,
      call: (args: BuiltinArg[]) => mkNumber(Math.abs(extractArgNumber(args, 0, NaN))),
    },
    floor: {
      name: "Math.floor",
      pure: true,
      call: (args: BuiltinArg[]) => mkNumber(Math.floor(extractArgNumber(args, 0, NaN))),
    },
    ceil: {
      name: "Math.ceil",
      pure: true,
      call: (args: BuiltinArg[]) => mkNumber(Math.ceil(extractArgNumber(args, 0, NaN))),
    },
    round: {
      name: "Math.round",
      pure: true,
      call: (args: BuiltinArg[]) => mkNumber(Math.round(extractArgNumber(args, 0, NaN))),
    },
    trunc: {
      name: "Math.trunc",
      pure: true,
      call: (args: BuiltinArg[]) => mkNumber(Math.trunc(extractArgNumber(args, 0, NaN))),
    },
    sign: {
      name: "Math.sign",
      pure: true,
      call: (args: BuiltinArg[]) => mkNumber(Math.sign(extractArgNumber(args, 0, NaN))),
    },
    sqrt: {
      name: "Math.sqrt",
      pure: true,
      call: (args: BuiltinArg[]) => mkNumber(Math.sqrt(extractArgNumber(args, 0, NaN))),
    },
    log: {
      name: "Math.log",
      pure: true,
      call: (args: BuiltinArg[]) => mkNumber(Math.log(extractArgNumber(args, 0, NaN))),
    },
    pow: {
      name: "Math.pow",
      pure: true,
      call: (args: BuiltinArg[]) =>
        mkNumber(
          Math.pow(
            extractArgNumber(args, 0, NaN),
            extractArgNumber(args, 1, NaN),
          ),
        ),
    },
    min: {
      name: "Math.min",
      pure: true,
      call: (args: BuiltinArg[]) => {
        if (args.length === 0) return mkDouble(Infinity);
        let min = extractArgNumber(args, 0, NaN);
        for (let i = 1; i < args.length; i++) {
          const val = extractArgNumber(args, i, NaN);
          if (val < min || Number.isNaN(val)) min = val;
        }
        return mkNumber(min);
      },
    },
    max: {
      name: "Math.max",
      pure: true,
      call: (args: BuiltinArg[]) => {
        if (args.length === 0) return mkDouble(-Infinity);
        let max = extractArgNumber(args, 0, NaN);
        for (let i = 1; i < args.length; i++) {
          const val = extractArgNumber(args, i, NaN);
          if (val > max || Number.isNaN(val)) max = val;
        }
        return mkNumber(max);
      },
    },
    random: { name: "Math.random", call: () => mkDouble(Math.random()) },
    PI: Math.PI,
    E: Math.E,
  },

  Array: {
    name: "Array",
    call(args: BuiltinArg[]) {
      return arrayConstruct(args);
    },
    construct(args: BuiltinArg[]) {
      return arrayConstruct(args);
    },
    push: {
      name: "Array.push",
      call(args: BuiltinArg[]) {
        if (args.length < 2) return mkSmi(0);
        const arr = args[0];
        if (!isArray(arr)) return mkUndefined();
        const jsArray = getPayload(arr);
        for (let i = 1; i < args.length; i++) {
          jsArray.push(args[i]);
        }
        return mkSmi(jsArray.getLength());
      },
    },
    pop: {
      name: "Array.pop",
      call(args: BuiltinArg[]) {
        if (args.length < 1) return mkUndefined();
        const arr = args[0];
        if (!isArray(arr)) return mkUndefined();
        const jsArray = getPayload(arr);
        const val = jsArray.pop();
        return val !== undefined ? val : mkUndefined();
      },
    },
    from: {
      name: "Array.from",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0) return mkArray(createJSArray([]));
        const src = args[0];
        const mapFn =
          args.length > 1 && isFunction(args[1]) ? args[1] : null;
        const out: TaggedValue[] = [];
        const emit = (value: TaggedValue | undefined) => {
          const v = value === undefined ? mkUndefined() : value;
          out.push(
            mapFn
              ? interpreter.callFunctionValue(
                  mapFn,
                  [v, mkNumber(out.length)],
                  mkUndefined(),
                )
              : v,
          );
        };

        if (isArray(src)) {
          const arr = getPayload(src);
          for (let i = 0; i < arr.getLength(); i++) emit(arr.getIndex(i));
          return mkArray(createJSArray(out));
        }
        if (isString(src)) {
          for (const ch of getPayload(src)) emit(mkString(ch));
          return mkArray(createJSArray(out));
        }
        if (isObject(src) || isIterator(src) || isGenerator(src)) {
          let iter = null;
          if (interpreter) {
            try {
              iter = getIterator(src, interpreter);
            } catch (e) {
              iter = null;
            }
          }
          if (iter && isIterator(iter)) {
            const record = getPayload(iter);
            for (let guard = 0; guard < 1e7; guard++) {
              const result = record.nextValue(interpreter);
              if (iteratorDone(result)) break;
              emit(iteratorValue(result));
            }
            return mkArray(createJSArray(out));
          }
          if (!isObject(src)) return mkArray(createJSArray([]));
          const obj = getPayload(src);
          const lenVal = obj.getProperty("length");
          const len = lenVal !== undefined ? toNumber(lenVal) : 0;
          const n = Number.isFinite(len) ? Math.max(0, Math.floor(len)) : 0;
          for (let i = 0; i < n; i++) emit(obj.getProperty(String(i)));
          return mkArray(createJSArray(out));
        }
        return mkArray(createJSArray([]));
      },
    },
    isArray: {
      name: "Array.isArray",
      call(args: BuiltinArg[]) {
        return mkBool(args.length > 0 && isArray(args[0]));
      },
    },
    of: {
      name: "Array.of",
      call(args: BuiltinArg[]) {
        return mkArray(createJSArray(args.slice()));
      },
    },
  },

  Object: {
    keys: {
      name: "Object.keys",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0) return mkArray(createJSArray([]));
        const obj = args[0];
        if (!isObject(obj)) return mkArray(createJSArray([]));
        return keysArray(runtimeOwnKeys(obj, interpreter));
      },
    },
    values: {
      name: "Object.values",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0) return mkArray(createJSArray([]));
        const obj = args[0];
        if (!isObject(obj)) return mkArray(createJSArray([]));
        const keys = runtimeOwnKeys(obj, interpreter);
        const values = keys.map((k) => runtimeGetProperty(obj, k, interpreter));
        return mkArray(createJSArray(values));
      },
    },
    entries: {
      name: "Object.entries",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0) return mkArray(createJSArray([]));
        const obj = args[0];
        if (!isObject(obj)) return mkArray(createJSArray([]));
        const entries = runtimeOwnKeys(obj, interpreter).map((k) =>
          mkArray(
            createJSArray([
              mkString(k),
              runtimeGetProperty(obj, k, interpreter),
            ]),
          ),
        );
        return mkArray(createJSArray(entries));
      },
    },
    assign: {
      name: "Object.assign",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0) return mkObject(createJSObject());
        const target = args[0];
        if (!isObject(target)) return target;
        for (let i = 1; i < args.length; i++) {
          const src = args[i];
          if (!isObject(src) || isNull(src) || isUndefined(src)) continue;
          for (const k of runtimeOwnKeys(src, interpreter)) {
            runtimeSetProperty(
              target,
              k,
              runtimeGetProperty(src, k, interpreter),
              interpreter,
            );
          }
        }
        return target;
      },
    },
    freeze: {
      name: "Object.freeze",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isObject(args[0]))
          return (args[0] === undefined ? mkUndefined() : args[0]);
        const obj = getPayload(args[0]);
        if (obj._frozen) return args[0];
        obj._frozen = true;
        return args[0];
      },
    },
    isFrozen: {
      name: "Object.isFrozen",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isObject(args[0])) return mkBool(true);
        return mkBool(!!getPayload(args[0])._frozen);
      },
    },
    seal: {
      name: "Object.seal",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isObject(args[0]))
          return args[0] === undefined ? mkUndefined() : args[0];
        const obj = getPayload(args[0]);
        obj._sealed = true;
        obj._nonExtensible = true;
        return args[0];
      },
    },
    isSealed: {
      name: "Object.isSealed",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isObject(args[0])) return mkBool(true);
        const obj = getPayload(args[0]);
        return mkBool(!!(obj._sealed || obj._frozen));
      },
    },
    preventExtensions: {
      name: "Object.preventExtensions",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isObject(args[0]))
          return args[0] === undefined ? mkUndefined() : args[0];
        getPayload(args[0])._nonExtensible = true;
        return args[0];
      },
    },
    isExtensible: {
      name: "Object.isExtensible",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isObject(args[0])) return mkBool(false);
        const obj = getPayload(args[0]);
        return mkBool(!(obj._nonExtensible || obj._sealed || obj._frozen));
      },
    },
    getPrototypeOf: {
      name: "Object.getPrototypeOf",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isObject(args[0])) return mkNull();
        const proto = getPayload(args[0]).prototype;
        return proto ? mkObject(proto) : mkNull();
      },
    },
    setPrototypeOf: {
      name: "Object.setPrototypeOf",
      call(args: BuiltinArg[]) {
        if (args.length < 2 || !isObject(args[0]))
          return args[0] === undefined ? mkUndefined() : args[0];
        getPayload(args[0]).setPrototype(
          isObject(args[1]) ? getPayload(args[1]) : null,
        );
        return args[0];
      },
    },
    create: {
      name: "Object.create",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        const obj = createJSObject();
        if (args.length > 0 && isObject(args[0])) {
          obj.setPrototype(getPayload(args[0]));
        }
        if (args.length > 1 && isObject(args[1]) && interpreter) {
          const descs = getPayload(args[1]);
          for (const key of descs.getOwnPropertyNames()) {
            const desc = descs.getProperty(key);
            if (isObject(desc)) {
              runtimeDefineProperty(mkObject(obj), key, desc, interpreter);
            }
          }
        }
        return mkObject(obj);
      },
    },
    hasOwn: {
      name: "Object.hasOwn",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length < 2 || !isObject(args[0])) return mkBool(false);
        const key = toDisplayString(args[1]);
        return mkBool(
          !isUndefined(
            runtimeGetOwnPropertyDescriptor(args[0], key, interpreter),
          ),
        );
      },
    },
    defineProperty: {
      name: "Object.defineProperty",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length < 3 || !isObject(args[0]) || !isObject(args[2]))
          return (args[0] === undefined ? mkUndefined() : args[0]);
        const key = toDisplayString(args[1]);
        runtimeDefineProperty(args[0], key, args[2], interpreter);
        return args[0];
      },
    },
    getOwnPropertyDescriptor: {
      name: "Object.getOwnPropertyDescriptor",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length < 2 || !isObject(args[0])) return mkUndefined();
        const key = toDisplayString(args[1]);
        return runtimeGetOwnPropertyDescriptor(args[0], key, interpreter);
      },
    },
  },

  Reflect: {
    get: {
      name: "Reflect.get",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0 || !isObject(args[0])) return mkUndefined();
        return runtimeGetProperty(args[0], toDisplayString(args[1]), interpreter);
      },
    },
    set: {
      name: "Reflect.set",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length < 2 || !isObject(args[0])) return mkBool(false);
        runtimeSetProperty(args[0], toDisplayString(args[1]), args[2], interpreter);
        return mkBool(true);
      },
    },
    has: {
      name: "Reflect.has",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length < 2 || !isObject(args[0])) return mkBool(false);
        return mkBool(runtimeHasProperty(args[0], toDisplayString(args[1]), interpreter));
      },
    },
    deleteProperty: {
      name: "Reflect.deleteProperty",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length < 2 || !isObject(args[0])) return mkBool(false);
        return mkBool(runtimeDeleteProperty(args[0], toDisplayString(args[1]), interpreter));
      },
    },
    ownKeys: {
      name: "Reflect.ownKeys",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0 || !isObject(args[0]))
          return mkArray(createJSArray([]));
        return keysArray(runtimeOwnKeys(args[0], interpreter));
      },
    },
    defineProperty: {
      name: "Reflect.defineProperty",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length < 3 || !isObject(args[0]) || !isObject(args[2]))
          return mkBool(false);
        runtimeDefineProperty(args[0], toDisplayString(args[1]), args[2], interpreter);
        return mkBool(true);
      },
    },
    getOwnPropertyDescriptor: {
      name: "Reflect.getOwnPropertyDescriptor",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length < 2 || !isObject(args[0])) return mkUndefined();
        return runtimeGetOwnPropertyDescriptor(
          args[0],
          toDisplayString(args[1]),
          interpreter,
        );
      },
    },
    apply: {
      name: "Reflect.apply",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0) return mkUndefined();
        const target = args[0];
        const thisArg = args.length > 1 ? args[1] : mkUndefined();
        const list =
          args.length > 2 && isArray(args[2])
            ? getPayload(args[2]).elements.map((value) => value ?? mkUndefined())
            : [];
        return interpreter.callFunctionValue(target, list.slice(), thisArg);
      },
    },
    construct: {
      name: "Reflect.construct",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0) return mkUndefined();
        const target = args[0];
        const list =
          args.length > 1 && isArray(args[1])
            ? getPayload(args[1]).elements.map((value) => value ?? mkUndefined())
            : [];
        return interpreter.constructFunctionValue(target, list.slice());
      },
    },
    getPrototypeOf: {
      name: "Reflect.getPrototypeOf",
      call(args: BuiltinArg[]) {
        if (args.length === 0 || !isObject(args[0])) return mkNull();
        const proto = getPayload(args[0]).prototype;
        return proto ? mkObject(proto) : mkNull();
      },
    },
    setPrototypeOf: {
      name: "Reflect.setPrototypeOf",
      call(args: BuiltinArg[]) {
        if (args.length < 2 || !isObject(args[0])) return mkBool(false);
        getPayload(args[0]).setPrototype(
          isObject(args[1]) ? getPayload(args[1]) : null,
        );
        return mkBool(true);
      },
    },
  },

  JSON: {
    parse: {
      name: "JSON.parse",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        const str = extractArgString(args, 0, "");
        let parsed: TaggedValue;
        try {
          const nativeParsed = JSON.parse(str) as JsonNativeValue;
          parsed = jsValueFromNative(nativeParsed);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          throw new Error(`SyntaxError: ${message}`);
        }
        
        if (args.length > 1 && interpreter) {
          const reviver = args[1];
          if (typeof reviver === "number") {
            
            parsed = walkReviver(parsed, "", reviver, interpreter);
          }
        }
        return parsed;
      },
    },
    stringify: {
      name: "JSON.stringify",
      call(args: BuiltinArg[], _this: TaggedValue, interpreter: BuiltinInterpreter) {
        if (args.length === 0) return mkUndefined();
        const val = args[0];
        const replacer = args.length > 1 ? args[1] : undefined;
        const indent = args.length > 2 ? extractArgNumber(args, 2, 0) : 0;

        let nativeReplacer:
          | ((this: BuiltinThis, key: string, value: JsonNativeValue) => JsonReplacerValue)
          | undefined;
        if (
          replacer !== undefined &&
          !isNull(replacer) &&
          !isUndefined(replacer)
        ) {
          if (isArray(replacer)) {
            
            const allowedKeys = new Set();
            const arr = getPayload(replacer);
            for (let i = 0; i < arr.getLength(); i++) {
              allowedKeys.add(toDisplayString(arr.elements[i] ?? mkUndefined()));
            }
            nativeReplacer = (key: string, value: JsonNativeValue) => {
              if (key === "") return value; 
              return allowedKeys.has(key) ? value : undefined;
            };
          } else if (interpreter) {
            
            nativeReplacer = (key: string, value: JsonNativeValue) => {
              const result = interpreter.callFunctionValue(
                replacer,
                [mkString(key), jsValueFromNative(value)],
                mkUndefined(),
              );
              return taggedToNative(result);
            };
          }
        }

        return mkString(
          JSON.stringify(
            taggedToNative(val),
            nativeReplacer,
            indent || undefined,
          ),
        );
      },
    },
  },

  String: {
    name: "String",
    call(args: BuiltinArg[]) {
      if (args.length === 0) return mkString("");
      return mkString(toString(args[0]));
    },
    fromCharCode: {
      name: "String.fromCharCode",
      pure: true,
      call(args: BuiltinArg[]) {
        return mkString(
          String.fromCharCode(...args.map((a) => toNumber(a) & 0xffff)),
        );
      },
    },
    fromCodePoint: {
      name: "String.fromCodePoint",
      pure: true,
      call(args: BuiltinArg[]) {
        return mkString(
          String.fromCodePoint(...args.map((a) => toNumber(a) >>> 0)),
        );
      },
    },
  },

  clock: {
    name: "clock",
    call() {
      return mkDouble(performance.now());
    },
  },

  gc: {
    name: "gc",
    call() {
      tracer.log(
        "gc",
        "Triggering garbage collection / hidden class stats dump",
      );
      return mkUndefined();
    },
  },
};

export type BuiltinRegistry = typeof builtins;
export type BuiltinRegistryEntry = BuiltinRegistry[keyof BuiltinRegistry];

function taggedToNative(val: TaggedValue, seen?: Set<object>): JsonNativeValue {
  if (isNull(val) || isUndefined(val)) return null;
  if (isSmi(val) || isDouble(val) || isNumber(val)) return toNumber(val);
  if (isString(val)) return getPayload(val);
  if (isBool(val)) return getPayload(val);
  if (isArray(val)) {
    const arr = getPayload(val);
    const visited = seen || new Set();
    if (visited.has(arr))
      throw new VMTypeError("Converting circular structure to JSON");
    visited.add(arr);
    const result = arr.elements.map((e) => taggedToNative(e ?? mkUndefined(), visited));
    visited.delete(arr);
    return result;
  }
  if (isObject(val)) {
    const obj = getPayload(val);
    const visited = seen || new Set();
    if (visited.has(obj))
      throw new VMTypeError("Converting circular structure to JSON");
    visited.add(obj);
    const result: JsonNativeObject = {};
    for (const [k, v] of obj.entries()) {
      const value = v ?? mkUndefined();
      if (isUndefined(value) || isFunction(value)) continue;
      result[k] = taggedToNative(value, visited);
    }
    visited.delete(obj);
    return result;
  }
  return null;
}

function walkReviver(
  val: TaggedValue,
  key: string,
  reviver: TaggedValue,
  interpreter: BuiltinInterpreter,
): TaggedValue {
  if (isObject(val)) {
    const obj = getPayload(val);
    for (const [k, v] of obj.entries()) {
      const newVal = walkReviver(v ?? mkUndefined(), k, reviver, interpreter);
      if (isUndefined(newVal)) {
        obj.deleteProperty(k);
      } else {
        obj.setProperty(k, newVal);
      }
    }
  } else if (isArray(val)) {
    const arr = getPayload(val);
    for (let i = 0; i < arr.getLength(); i++) {
      const newVal = walkReviver(
        arr.elements[i] ?? mkUndefined(),
        String(i),
        reviver,
        interpreter,
      );
      if (isUndefined(newVal)) {
        arr.elements[i] = mkUndefined();
      } else {
        arr.elements[i] = newVal;
      }
    }
  }
  return interpreter.callFunctionValue(
    reviver,
    [mkString(key), val],
    mkUndefined(),
  );
}

function jsValueFromNative(val: JsonNativeValue): TaggedValue {
  if (val === null) return mkNull();
  if (val === undefined) return mkUndefined();
  if (typeof val === "number") return mkNumber(val);
  if (typeof val === "string") return mkString(val);
  if (typeof val === "boolean") return mkBool(val);
  if (Array.isArray(val)) {
    return mkArray(createJSArray(val.map((e) => jsValueFromNative(e))));
  }
  if (typeof val === "object") {
    const obj = createJSObject();
    for (const [k, v] of Object.entries(val)) {
      obj.setProperty(k, jsValueFromNative(v));
    }
    return mkObject(obj);
  }
  return mkUndefined();
}
