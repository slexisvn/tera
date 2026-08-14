import type { AotSkippedFunction } from "./artifact.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
  type AotScalar,
} from "../types/scalar.js";

export type EntryDelivery = "print" | "exit";

export type EntryResult = "int" | "float" | "string";

export interface ProgramEntryShape {
  readonly result: EntryResult;
  readonly delivery: EntryDelivery;
}

export type ProgramEntryShapeResult =
  | { readonly ok: true; readonly shape: ProgramEntryShape }
  | { readonly ok: false; readonly reason: string };

const RESULTS = new Map<AotScalar, EntryResult>([
  [SCALAR_INT32, "int"],
  [SCALAR_FLOAT64, "float"],
  [SCALAR_STRING, "string"],
]);

const ACCEPTED_PARAMETERS = "takes no parameters; read what it needs with input()";
const ACCEPTED_RESULTS = [...RESULTS.values()].join(", ");

export function defaultDelivery(returns: AotScalar): EntryDelivery {
  return returns === SCALAR_INT32 ? "exit" : "print";
}

export function programEntryShape(
  parameters: readonly AotScalar[],
  returns: AotScalar,
  delivery: EntryDelivery,
): ProgramEntryShapeResult {
  if (parameters.length > 0) {
    return {
      ok: false,
      reason: `takes (${parameters.join(", ")}); an entry ${ACCEPTED_PARAMETERS}`,
    };
  }
  const result = RESULTS.get(returns);
  if (result === undefined) {
    return { ok: false, reason: `returns ${returns}; an entry returns ${ACCEPTED_RESULTS}` };
  }
  if (delivery === "exit" && result !== "int") {
    return { ok: false, reason: `returns ${returns}, which cannot be an exit status` };
  }
  return { ok: true, shape: { result, delivery } };
}

function droppedCause(
  dropped: AotSkippedFunction,
  skipped: readonly AotSkippedFunction[],
): string {
  const byName = new Map(skipped.map((fn) => [fn.name, fn]));
  const calls: string[] = [];
  const seen = new Set<string>([dropped.name]);
  let cause = dropped;
  while (cause.missing !== undefined && !seen.has(cause.missing)) {
    const next = byName.get(cause.missing);
    if (next === undefined) break;
    seen.add(next.name);
    calls.push(next.name);
    cause = next;
  }
  if (calls.length === 0) return cause.reason;
  return `it calls ${calls.join(" -> ")}, skipped because ${cause.reason}`;
}

export function missingEntryReason(
  name: string,
  available: readonly string[],
  skipped: readonly AotSkippedFunction[],
): string {
  const dropped = skipped.find((fn) => fn.name === name);
  if (dropped !== undefined) {
    return `entry function ${name} could not be lowered to native code: ${droppedCause(dropped, skipped)}`;
  }
  const hint = available.length > 0 ? ` (available: ${available.join(", ")})` : "";
  return `no compiled function is named ${name}${hint}`;
}
