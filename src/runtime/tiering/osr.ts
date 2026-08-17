import type * as bytecode from "../../bytecode/register/ops/bytecode.js";
import { requiresInterpreterOnly } from "../../bytecode/register/interpreter/helpers.js";
import { mkUndefined, type TaggedValue } from "../../core/value/index.js";
import type { Environment } from "../intrinsics/environment.js";

export type OsrCapableEngine = {
  osrEnabled?: boolean;
  compileOsr?: (
    compiledFn: bytecode.RegisterCompiledFunction,
    offset: number,
  ) => bytecode.OsrEntry | null;
};

export type OsrHost = {
  jitEngine?: OsrCapableEngine | null;
  tieringPolicy?: object | null;
};

export type RegisterReader = (slot: number) => TaggedValue;

export function enterOsr(
  host: OsrHost,
  compiledFn: bytecode.RegisterCompiledFunction,
  target: number,
  readRegister: RegisterReader,
  thisValue: TaggedValue,
  closureEnv: Environment | null,
): TaggedValue | null {
  const feedback = compiledFn.feedbackVector;
  if (feedback && feedback.osrUrgency === 0) {
    feedback.incrementOsrUrgency();
    return null;
  }

  const engine = host.jitEngine;
  if (
    !engine ||
    !host.tieringPolicy ||
    engine.osrEnabled === false ||
    compiledFn.disableOptimization ||
    requiresInterpreterOnly(compiledFn) ||
    typeof engine.compileOsr !== "function"
  ) {
    return null;
  }

  let entry = compiledFn.osrCache.get(target);
  if (entry === undefined) {
    entry = engine.compileOsr(compiledFn, target);
  }
  if (feedback) feedback.resetLoopBudget();
  if (!entry) return null;

  const args: TaggedValue[] = [];
  for (const slot of entry.slots) {
    const value = readRegister(slot);
    args.push(value === undefined ? mkUndefined() : value);
  }
  if (entry.code._declinesEntry?.(args)) return null;
  return entry.code(args, thisValue, host, closureEnv);
}
