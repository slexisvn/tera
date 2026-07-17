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

type HostObject = JSObject & {
  _hostValue?: unknown;
};

type NativeFunction = (...args: unknown[]) => unknown;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function taggedToNative(value: TaggedValue): unknown {
  if (isUndefined(value)) return undefined;
  if (isNull(value)) return null;
  if (isString(value) || isSmi(value) || isDouble(value) || isBool(value)) return getPayload(value);
  if (isArray(value)) return getPayload(value).elements.map((item) => item === undefined ? undefined : taggedToNative(item));
  if (isObject(value)) {
    const object = getPayload(value) as HostObject;
    if (object._hostValue !== undefined) return object._hostValue;
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

function wrapHostObject(value: object): TaggedValue {
  const object = createJSObject() as HostObject;
  object._hostValue = value;
  object.toString = () => typeof value.toString === "function" ? value.toString() : `[Host ${value.constructor?.name || "Object"}]`;
  for (const name of methodNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name) ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), name);
    const property = (value as Record<string, unknown>)[name];
    if (typeof property === "function") {
      object.setProperty(name, mkFunction(hostMethod(value, name)));
    } else if (descriptor?.get) {
      object.setProperty(name, nativeToTagged(property));
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
