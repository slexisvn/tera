import * as mlfw from "@slexisvn/mlfw";
import type { RuntimeFunctionMetadata, RuntimeFunctionPayload, TaggedValue } from "../../core/value/index.js";
import { bindNamedSlots, isNamedArguments } from "../named-arguments.js";
import { camelToSnake, snakeToCamel } from "../../utils/naming.js";
import { hostBuiltin, optionsArg, registerHostType } from "./host.js";

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
  const named = isNamedArguments(last);
  const options = named ? optionsArg(last) : {};
  if (named) values.pop();
  return { values, options };
}

export function bindArgs(args: unknown[], metadata?: RuntimeFunctionMetadata): { values: unknown[]; options: Record<string, unknown> } {
  const { values, options } = splitOptions(args);
  const named = Object.entries(options).map(([name, value]) => ({ name, value }));
  const bound = bindNamedSlots(metadata?.params, values, named, undefined);
  return { values: bound.values, options: camelOptions(Object.fromEntries(bound.rest.map(({ name, value }) => [name, value]))) };
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

export function registerHostKinds(
  source: Record<string, unknown>,
  names: readonly string[],
  metadata: Record<string, RuntimeFunctionMetadata>,
): void {
  for (const name of names) {
    const kind = metadata[name]?.kind;
    if (kind) registerHostType(source[name], kind);
  }
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
