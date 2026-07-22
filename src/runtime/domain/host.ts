import {
  mkArray,
  mkBool,
  mkDouble,
  mkFunction,
  mkNull,
  mkObject,
  mkString,
  mkUndefined,
  getPayload,
  isArray,
  isBool,
  isDouble,
  isFunction,
  isNull,
  isObject,
  isPromise,
  isSmi,
  isString,
  isUndefined,
  type RuntimeFunctionPayload,
  type RuntimeFunctionMetadata,
  type TaggedValue,
} from "../../core/value/index.js";
import { createJSArray, createJSMap, createJSObject } from "../../objects/heap/factory.js";
import type { JSObject } from "../../objects/heap/js-object.js";
import { AccessorPair } from "../../objects/heap/js-object.js";
import { camelToSnake } from "../../core/naming.js";
import { mkPromiseCapability } from "../async/promise.js";
import type { MicrotaskQueue } from "../microtasks/microtask.js";
import { MODEL_MARKER } from "../../frontend/parser/index.js";
import { formatHostValue } from "./format.js";
import { installHostIndexing } from "./indexing.js";

type HostInterpreter = {
  callFunctionValue(fn: TaggedValue, args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
  constructFunctionValue(fn: TaggedValue, args: TaggedValue[]): TaggedValue;
};

type HostAsyncBinding = {
  queue: MicrotaskQueue;
  drain: () => void;
  interpreter: HostInterpreter;
};

let hostAsync: HostAsyncBinding | null = null;
let modelBridge: ((model: TaggedValue, interpreter: HostInterpreter) => unknown) | null = null;

export function bindHostAsync(binding: HostAsyncBinding | null): void {
  hostAsync = binding;
}

export function bindModelBridge(bridge: typeof modelBridge): void {
  modelBridge = bridge;
}

function isThenable(value: object): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown }).then === "function";
}

function thenableToTagged(value: PromiseLike<unknown>): TaggedValue {
  const binding = hostAsync!;
  const { capability, value: promise } = mkPromiseCapability(binding.queue);
  value.then(
    (settled) => {
      capability.resolve(nativeToTagged(settled));
      binding.drain();
    },
    (reason) => {
      capability.reject(nativeToTagged(reason));
      binding.drain();
    },
  );
  return promise;
}

type HostObject = JSObject & {
  _hostValue?: unknown;
  _display?: (compact: boolean) => string;
};

type NativeFunction = (...args: unknown[]) => unknown;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type PromiseRecord = {
  state: string;
  result: TaggedValue;
  addReaction(reaction: (state: string, result: TaggedValue) => void): void;
};

export function taggedToPromise(value: TaggedValue): Promise<unknown> {
  const record = getPayload(value) as PromiseRecord;
  hostAsync?.drain();
  if (record.state === "fulfilled") return Promise.resolve(taggedToNative(record.result));
  if (record.state === "rejected") return Promise.reject(taggedToNative(record.result));
  return new Promise((resolve, reject) => {
    record.addReaction((state, result) => {
      if (state === "fulfilled") resolve(taggedToNative(result));
      else reject(taggedToNative(result));
    });
    hostAsync?.drain();
  });
}

export function taggedToNative(value: TaggedValue): unknown {
  if (isUndefined(value)) return undefined;
  if (isNull(value)) return null;
  if (isPromise(value)) return taggedToPromise(value);
  if (isString(value) || isSmi(value) || isDouble(value) || isBool(value)) return getPayload(value);
  if (isArray(value)) return getPayload(value).elements.map((item) => item === undefined ? undefined : taggedToNative(item));
  if (isObject(value)) {
    const object = getPayload(value) as HostObject;
    if (object._hostValue !== undefined) return object._hostValue;
    if (modelBridge && hostAsync && object.hiddenClass.properties.some(([key]) => key === MODEL_MARKER)) {
      return modelBridge(value, hostAsync.interpreter);
    }
    if (object._mapData) {
      const out = new Map<unknown, unknown>();
      for (const [key, inner] of object._mapData.iterateEntries()) out.set(taggedToNative(key), taggedToNative(inner));
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, desc] of object.hiddenClass.properties) {
      const raw = desc.offset < object.slots.length ? object.slots[desc.offset] : object.overflowProperties?.get(key);
      if (raw !== undefined && !(raw instanceof AccessorPair)) out[key] = taggedToNative(raw);
    }
    if (object.overflowProperties) {
      for (const [key, raw] of object.overflowProperties) {
        if (raw !== undefined && !(raw instanceof AccessorPair) && !(key in out)) out[key] = taggedToNative(raw);
      }
    }
    return out;
  }
  if (isFunction(value)) return value;
  return getPayload(value);
}

function methodNames(value: object): string[] {
  const names = new Set<string>();
  let current: object | null = value;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name !== "constructor") names.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...names];
}

function hostMethod(value: object, name: string): RuntimeFunctionPayload {
  return {
    name,
    call(args: TaggedValue[]) {
      const target = value as Record<string, unknown>;
      const fn = target[name];
      if (typeof fn !== "function") return nativeToTagged(target[name]);
      return nativeToTagged((fn as NativeFunction).apply(value, args.map(taggedToNative)));
    },
  };
}

function ownDescriptor(value: object, name: string): PropertyDescriptor | undefined {
  let current: object | null = value;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function hostSetter(value: object, name: string): RuntimeFunctionPayload {
  return {
    name,
    call(args: TaggedValue[]) {
      (value as Record<string, unknown>)[name] = args[0] === undefined ? undefined : taggedToNative(args[0]);
      return mkUndefined();
    },
  };
}

function wrapHostObject(value: object): TaggedValue {
  const object = createJSObject() as HostObject;
  object._hostValue = value;
  object.toString = () => typeof value.toString === "function" ? value.toString() : `[Host ${value.constructor?.name || "Object"}]`;
  object._display = (compact: boolean) => formatHostValue(value, compact) ?? object.toString();
  installHostIndexing(object, value, nativeToTagged);
  const native = new Set(methodNames(value));
  for (const name of native) {
    const descriptor = ownDescriptor(value, name);
    if (!descriptor) continue;
    const alias = camelToSnake(name);
    const names = native.has(alias) ? [name] : [name, alias];
    if (typeof descriptor.value === "function") {
      for (const exposed of new Set(names)) object.setProperty(exposed, mkFunction(hostMethod(value, name)));
      continue;
    }
    const settable = descriptor.get ? descriptor.set !== undefined : descriptor.writable !== false;
    for (const exposed of new Set(names)) {
      object.defineProperty(exposed, {
        kind: "accessor",
        writable: settable,
        enumerable: true,
        configurable: true,
        value: new AccessorPair(
          mkFunction(hostMethod(value, name)),
          settable ? mkFunction(hostSetter(value, name)) : undefined,
        ),
      });
    }
  }
  return mkObject(object);
}

export function nativeToTagged(value: unknown): TaggedValue {
  if (value === undefined) return mkUndefined();
  if (value === null) return mkNull();
  if (typeof value === "string") return mkString(value);
  if (typeof value === "number") return mkDouble(value);
  if (typeof value === "boolean") return mkBool(value);
  if (Array.isArray(value)) return mkArray(createJSArray(value.map(nativeToTagged)));
  if (value instanceof Map) {
    const object = createJSMap();
    for (const [key, inner] of value) object._mapData?.set(nativeToTagged(key), nativeToTagged(inner));
    return mkObject(object);
  }
  if (typeof value === "function") {
    return mkFunction({
      name: value.name || "host",
      call(args: TaggedValue[]) {
        return nativeToTagged((value as NativeFunction)(...args.map(taggedToNative)));
      },
      construct(args: TaggedValue[]) {
        return nativeToTagged(new (value as { new (...args: unknown[]): unknown })(...args.map(taggedToNative)));
      },
    });
  }
  if (typeof value === "object") {
    if (hostAsync && isThenable(value)) return thenableToTagged(value);
    if (isPlainObject(value)) {
      const object = createJSObject();
      for (const [key, inner] of Object.entries(value)) object.setProperty(key, nativeToTagged(inner));
      return mkObject(object);
    }
    return wrapHostObject(value);
  }
  return mkString(String(value));
}

export function hostBuiltin(name: string, fn: NativeFunction, metadata?: RuntimeFunctionMetadata): RuntimeFunctionPayload {
  return {
    name,
    metadata,
    call(args: TaggedValue[]) {
      return nativeToTagged(fn(...args.map(taggedToNative)));
    },
    construct(args: TaggedValue[]) {
        return nativeToTagged(new (fn as unknown as { new (...args: unknown[]): unknown })(...args.map(taggedToNative)));
    },
  };
}

export function optionsArg(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map)) return value as Record<string, unknown>;
  return {};
}
