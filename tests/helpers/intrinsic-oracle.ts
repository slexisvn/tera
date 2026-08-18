import {
  mkBool,
  mkNumber,
  mkString,
  mkUndefined,
} from "../../src/core/value/index.js";
import type { TaggedValue } from "../../src/core/value/index.js";

export type PlainArgument = number | string | boolean | undefined;

export const ARGUMENT_VALUES: readonly PlainArgument[] = [
  undefined,
  0,
  1,
  2,
  1.5,
  2.9,
  -0.5,
  -1,
  -2,
  -2.5,
  "1",
  "2",
  "",
  "nope",
  true,
  false,
  2000000000,
  -2000000000,
  Infinity,
  -Infinity,
  NaN,
];

export function tagged(value: PlainArgument): TaggedValue {
  if (value === undefined) return mkUndefined();
  if (typeof value === "number") return mkNumber(value);
  if (typeof value === "string") return mkString(value);
  return mkBool(value);
}

export function argumentLists(arity: number): PlainArgument[][] {
  let lists: PlainArgument[][] = [[]];
  const all: PlainArgument[][] = [[]];
  for (let length = 0; length < arity; length++) {
    lists = lists.flatMap((prefix) =>
      ARGUMENT_VALUES.map((value) => [...prefix, value]),
    );
    all.push(...lists);
  }
  return all;
}

export type Outcome<T> = { value: T } | { error: string };

export function outcome<T>(run: () => T): Outcome<T> {
  try {
    return { value: run() };
  } catch (error) {
    return { error: (error as Error).constructor.name };
  }
}

export function describeArguments(args: readonly PlainArgument[]): string {
  return `(${args.map((value) => String(value)).join(", ")})`;
}
