import type { RuntimeFunctionMetadata, RuntimeFunctionPayload } from "../../core/value/index.js";
import { hostBuiltin, optionsArg } from "./host.js";

export type BuiltinMap = Record<string, RuntimeFunctionPayload>;
export type NativeFn = (...args: unknown[]) => unknown;
export type NativeCtor = new (...args: unknown[]) => unknown;

const OPTION_ALIASES: Record<string, string> = {
  grad: "requiresGrad",
};

export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function camelOptions(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const name = snakeToCamel(key);
    out[OPTION_ALIASES[name] ?? name] = value;
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

export function callWithOptions(fn: NativeFn): NativeFn {
  return (...args) => {
    const { values, options } = splitOptions(args);
    return fn(...values, ...Object.keys(options).length > 0 ? [camelOptions(options)] : []);
  };
}

export function constructWithOptions(Cls: NativeCtor): NativeFn {
  return (...args) => {
    const { values, options } = splitOptions(args);
    return new Cls(...values, ...Object.keys(options).length > 0 ? [camelOptions(options)] : []);
  };
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
      out[key] = wrapped;
    }
    return out;
  }
  return value;
}
