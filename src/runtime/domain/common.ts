import * as mlfw from "@slexisvn/mlfw";
import type { RuntimeFunctionMetadata, RuntimeFunctionPayload, TaggedValue } from "../../core/value/index.js";
import { camelToSnake, snakeToCamel } from "../../core/naming.js";
import { hostBuiltin, optionsArg } from "./host.js";

export { snakeToCamel };

export type BuiltinConstant = { name: string; metadata?: RuntimeFunctionMetadata; globalConst: () => TaggedValue };
export type BuiltinMap = Record<string, RuntimeFunctionPayload | BuiltinConstant>;
export type NativeFn = (...args: unknown[]) => unknown;
export type NativeCtor = new (...args: unknown[]) => unknown;

const OPTION_ALIASES: Record<string, string> = {
  grad: "requiresGrad",
};

const DEVICES: Record<string, unknown> = {
  cpu: mlfw.CPU_DEVICE,
  gpu: mlfw.GPU_DEVICE,
  wasm: mlfw.WASM_DEVICE,
  webgpu: mlfw.WEBGPU_DEVICE,
};

export function resolveDevice(value: unknown): unknown {
  return typeof value === "string" && value in DEVICES ? DEVICES[value] : value;
}

export function camelOptions(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const name = snakeToCamel(key);
    const target = OPTION_ALIASES[name] ?? name;
    out[target] = target === "device" ? resolveDevice(value) : value;
  }
  return out;
}

function isPlainOptions(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function splitOptions(args: unknown[]): { values: unknown[]; options: Record<string, unknown> } {
  const values = args.slice();
  const last = values[values.length - 1];
  const options = isPlainOptions(last) ? optionsArg(last) : {};
  if (Object.keys(options).length > 0 && last === options) values.pop();
  return { values, options };
}

const PARAM_SYNONYMS: Record<string, string> = {
  axis: "dim",
  dim: "axis",
};

const EMPTY_SLOTS: ReadonlyMap<string, number> = new Map();
const slotCache = new WeakMap<RuntimeFunctionMetadata, ReadonlyMap<string, number>>();

function positionalSlots(metadata?: RuntimeFunctionMetadata): ReadonlyMap<string, number> {
  if (!metadata?.params) return EMPTY_SLOTS;
  const cached = slotCache.get(metadata);
  if (cached) return cached;

  const slots = new Map<string, number>();
  let index = 0;
  for (const param of metadata.params) {
    if (param.named || param.rest) continue;
    const synonym = PARAM_SYNONYMS[param.name];
    slots.set(param.name, index);
    slots.set(snakeToCamel(param.name), index);
    if (synonym) slots.set(synonym, index);
    index++;
  }
  slotCache.set(metadata, slots);
  return slots;
}

export function bindArgs(args: unknown[], metadata?: RuntimeFunctionMetadata): { values: unknown[]; options: Record<string, unknown> } {
  const { values, options } = splitOptions(args);
  const slots = positionalSlots(metadata);
  if (slots.size === 0) return { values, options: camelOptions(options) };

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const slot = slots.get(key);
    if (slot === undefined) rest[key] = value;
    else if (values[slot] === undefined) values[slot] = value;
  }
  return { values, options: camelOptions(rest) };
}

function bound(metadata: RuntimeFunctionMetadata | undefined, apply: (args: unknown[]) => unknown): NativeFn {
  return (...args) => {
    const { values, options } = bindArgs(args, metadata);
    return apply(Object.keys(options).length > 0 ? [...values, options] : values);
  };
}

export function callWithOptions(fn: NativeFn, metadata?: RuntimeFunctionMetadata): NativeFn {
  return bound(metadata, (args) => fn(...args));
}

export function constructWithOptions(Cls: NativeCtor, metadata?: RuntimeFunctionMetadata): NativeFn {
  return bound(metadata, (args) => new Cls(...args));
}

export function register(map: BuiltinMap, name: string, fn: NativeFn, metadata?: RuntimeFunctionMetadata): void {
  map[name] = hostBuiltin(name, fn, metadata);
}

export function nativeRecord(value: unknown): Record<string, unknown> {
  if (value instanceof Map) return Object.fromEntries(value);
  return isPlainOptions(value) ? value : {};
}

export function recordValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recordValue);
  if (value && typeof value === "object" && !(value instanceof Map)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const wrapped = recordValue(inner);
      out[camelToSnake(key)] = wrapped;
    }
    return out;
  }
  return value;
}
