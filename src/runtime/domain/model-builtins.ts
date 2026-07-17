import * as mlfw from "@slexisvn/mlfw";
import {
  getPayload,
  isBool,
  isFunction,
  isObject,
  isString,
  mkArray,
  mkBool,
  mkObject,
  mkUndefined,
  toBool,
  toDisplayString,
  type RuntimeFunctionPayload,
  type TaggedValue,
} from "../../core/value/index.js";
import { createJSArray } from "../../objects/heap/factory.js";
import { runtimeGetProperty } from "../../objects/exotic/proxy-ops.js";
import { nativeToTagged, optionsArg, taggedToNative } from "./host.js";
import { DOMAIN_BUILTIN_METADATA } from "./metadata.js";

type InterpreterLike = {
  callFunctionValue(fn: TaggedValue, args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
  constructFunctionValue(fn: TaggedValue, args: TaggedValue[]): TaggedValue;
};

type NativeModule = {
  parameters?: () => Iterable<unknown>;
  train?: () => unknown;
  eval?: () => unknown;
  _training?: boolean;
  _parameters?: unknown;
  _modules?: unknown;
};

type BuiltinMap = Record<string, RuntimeFunctionPayload>;

const ml = mlfw as Record<string, unknown>;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function nativeEntries(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (value instanceof Map) return [...value.values()];
  if (Array.isArray(value)) return value;
  return Object.values(value as Record<string, unknown>);
}

function collectNativeParameters(value: unknown, seen: Set<object>, out: unknown[]): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  const module = value as NativeModule;
  if (typeof module.parameters === "function") {
    for (const param of module.parameters()) out.push(param);
    return;
  }
  for (const param of nativeEntries(module._parameters)) out.push(param);
  for (const child of nativeEntries(module._modules)) collectNativeParameters(child, seen, out);
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectNativeParameters(child, seen, out);
  }
}

function collectParameters(value: TaggedValue, seenTagged: Set<object>, seenNative: Set<object>, out: TaggedValue[]): void {
  if (!isObject(value)) return;
  const object = getPayload(value);
  if (seenTagged.has(object)) return;
  seenTagged.add(object);
  const native = taggedToNative(value);
  const nativeOut: unknown[] = [];
  collectNativeParameters(native, seenNative, nativeOut);
  for (const param of nativeOut) out.push(nativeToTagged(param));
  for (const [, child] of object.entries()) {
    if (child !== undefined && isObject(child)) collectParameters(child, seenTagged, seenNative, out);
  }
}

function setNativeTraining(value: unknown, training: boolean, seen: Set<object>): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  const module = value as NativeModule;
  if (training && typeof module.train === "function") module.train();
  else if (!training && typeof module.eval === "function") module.eval();
  if ("_training" in module) module._training = training;
  for (const child of nativeEntries(module._modules)) setNativeTraining(child, training, seen);
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) setNativeTraining(child, training, seen);
  }
}

function setTraining(value: TaggedValue, training: boolean, seenTagged: Set<object>, seenNative: Set<object>): void {
  if (!isObject(value)) return;
  const object = getPayload(value);
  if (seenTagged.has(object)) return;
  seenTagged.add(object);
  setNativeTraining(taggedToNative(value), training, seenNative);
  object.setProperty("_training", mkBool(training));
  for (const [, child] of object.entries()) {
    if (child !== undefined && isObject(child)) setTraining(child, training, seenTagged, seenNative);
  }
}

function optimizerClass(name: string): new (...args: unknown[]) => unknown {
  const normalized = name.toLowerCase();
  if (normalized === "sgd") return ml.SGD as new (...args: unknown[]) => unknown;
  if (normalized === "adamw") return ml.AdamW as new (...args: unknown[]) => unknown;
  return ml.Adam as new (...args: unknown[]) => unknown;
}

function optionRecord(args: TaggedValue[]): Record<string, unknown> {
  const last = args[args.length - 1];
  return last === undefined ? {} : optionsArg(taggedToNative(last));
}

function compileInput(args: TaggedValue[]): TaggedValue | undefined {
  const options = optionRecord(args);
  if ("input" in options) return nativeToTagged(options.input);
  return args.length > 1 ? args[1] : undefined;
}

function callModelForward(model: TaggedValue, input: TaggedValue, interpreter: InterpreterLike): void {
  if (isObject(model)) {
    const forward = runtimeGetProperty(model, "forward", interpreter);
    if (isFunction(forward)) {
      interpreter.callFunctionValue(forward, [input], model);
      return;
    }
  }
  if (isObject(model) || isFunction(model)) interpreter.callFunctionValue(model, [input], mkUndefined());
}

export function createModelBuiltins(): BuiltinMap {
  return {
    compile: {
      name: "compile",
      metadata: DOMAIN_BUILTIN_METADATA.compile,
      call(args: TaggedValue[], _this: TaggedValue, interpreter: InterpreterLike) {
        const model = args[0] ?? mkUndefined();
        const input = compileInput(args);
        if (input !== undefined) callModelForward(model, input, interpreter);
        return model;
      },
    },
    model_parameters: {
      name: "model_parameters",
      call(args: TaggedValue[]) {
        const out: TaggedValue[] = [];
        if (args[0] !== undefined) collectParameters(args[0], new Set(), new Set(), out);
        return mkArray(createJSArray(out));
      },
    },
    model_train: {
      name: "model_train",
      call(args: TaggedValue[]) {
        const model = args[0] ?? mkUndefined();
        const training = args[1] === undefined ? true : toBool(args[1]);
        setTraining(model, training, new Set(), new Set());
        return model;
      },
    },
    model_validate: {
      name: "model_validate",
      call(args: TaggedValue[], _this: TaggedValue, interpreter: InterpreterLike) {
        const model = args[0] ?? mkUndefined();
        const data = args[1] ?? mkUndefined();
        const target = args[2] ?? mkUndefined();
        const lossFn = args[3] ?? mkUndefined();
        setTraining(model, false, new Set(), new Set());
        if (!isObject(model)) return mkUndefined();
        const forward = runtimeGetProperty(model, "forward", interpreter);
        const prediction = isFunction(forward)
          ? interpreter.callFunctionValue(forward, [data], model)
          : interpreter.callFunctionValue(model, [data], mkUndefined());
        if (isFunction(lossFn)) return interpreter.callFunctionValue(lossFn, [prediction, target], mkUndefined());
        return prediction;
      },
    },
    model_optimizer: {
      name: "model_optimizer",
      call(args: TaggedValue[]) {
        const params: TaggedValue[] = [];
        const model = args[0] ?? mkUndefined();
        collectParameters(model, new Set(), new Set(), params);
        const kindArg = args[1];
        const kind = kindArg !== undefined && isString(kindArg) ? toDisplayString(kindArg) : "adam";
        const options = optionRecord(args);
        const Cls = optimizerClass(kind);
        return nativeToTagged(new Cls(params.map(taggedToNative), options));
      },
    },
    is_model_training: {
      name: "is_model_training",
      call(args: TaggedValue[]) {
        const model = args[0] ?? mkUndefined();
        if (!isObject(model)) return mkBool(false);
        const raw = runtimeGetProperty(model, "_training");
        if (isBool(raw)) return raw;
        return mkBool(false);
      },
    },
  };
}
