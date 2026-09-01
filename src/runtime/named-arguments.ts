import type { RuntimeFunctionParameterMetadata } from "../core/value/index.js";
import { snakeToCamel } from "../utils/naming.js";

export const NATIVE_NAMED_ARGUMENTS = Symbol.for("tera.nativeNamedArguments");

type NamedCarrier = {
  [NATIVE_NAMED_ARGUMENTS]?: true;
};

export type NamedArgument<T> = {
  readonly name: string;
  readonly value: T;
};

export function markNamedArguments<T extends object>(value: T): T {
  Object.defineProperty(value, NATIVE_NAMED_ARGUMENTS, { value: true });
  return value;
}

export function isNamedArguments(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as NamedCarrier)[NATIVE_NAMED_ARGUMENTS] === true;
}

const PARAM_SYNONYMS: Record<string, string> = {
  axis: "dim",
  dim: "axis",
};

const EMPTY_SLOTS: ReadonlyMap<string, number> = new Map();
const slotCache = new WeakMap<readonly RuntimeFunctionParameterMetadata[], ReadonlyMap<string, number>>();

export function positionalSlots(
  params?: readonly RuntimeFunctionParameterMetadata[],
): ReadonlyMap<string, number> {
  if (!params || params.length === 0) return EMPTY_SLOTS;
  const cached = slotCache.get(params);
  if (cached) return cached;

  const slots = new Map<string, number>();
  let index = 0;
  for (const param of params) {
    if (param.named || param.rest) continue;
    const synonym = PARAM_SYNONYMS[param.name];
    slots.set(param.name, index);
    slots.set(snakeToCamel(param.name), index);
    if (synonym) slots.set(synonym, index);
    index++;
  }
  slotCache.set(params, slots);
  return slots;
}

export function acceptsNamedOptions(
  params?: readonly RuntimeFunctionParameterMetadata[],
): boolean {
  return params === undefined || params.some((param) => param.named || param.rest);
}

export function bindNamedSlots<T>(
  params: readonly RuntimeFunctionParameterMetadata[] | undefined,
  positional: readonly T[],
  named: readonly NamedArgument<T>[],
  absent: T,
): { values: T[]; rest: NamedArgument<T>[] } {
  const slots = positionalSlots(params);
  if (slots.size === 0 || named.length === 0) return { values: [...positional], rest: [...named] };

  const values = [...positional];
  const rest: NamedArgument<T>[] = [];
  for (const argument of named) {
    const slot = slots.get(argument.name);
    if (slot === undefined || (slot < values.length && values[slot] !== absent)) {
      rest.push(argument);
      continue;
    }
    while (values.length < slot) values.push(absent);
    values[slot] = argument.value;
  }
  return { values, rest };
}
