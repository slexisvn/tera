import { createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import {
  compilerOptions,
  createBackendRegistry,
  Engine,
  nativeToTagged,
  OptBisect,
  taggedToNative,
  type CompilerOptions,
} from "tera";
import type { OptLevelId } from "../types/stage";
import { BASELINE_TIERING, COLD_TIERING, FORCED_TIERING, messageOf } from "./engine-options";

export type Observation = {
  readonly signature: string;
  readonly lines: readonly string[];
  readonly attempts: number;
  readonly ok: boolean;
};

export type Watch = {
  readonly optLevel: OptLevelId;
  readonly limit: number;
};

export type Ran = {
  readonly printed: readonly string[];
  readonly error: string | null;
};

export type Built = {
  readonly skipped: readonly string[];
  readonly error: string | null;
};

function hostOptions() {
  return createReactiveTeraOptions({ nativeToTagged, taggedToNative });
}

export function runWith(
  source: string,
  tiering: object,
  compiled: CompilerOptions | null,
): Ran {
  const printed: string[] = [];
  const engine = new Engine({
    ...hostOptions(),
    typecheck: "off",
    tieringPolicy: tiering,
    ...(compiled === null ? {} : { compilerOptions: compiled }),
    output: (text: string) => void printed.push(String(text)),
  });
  try {
    engine.run(source);
  } catch (error) {
    return { printed, error: messageOf(error) };
  }
  return { printed, error: null };
}

export function buildWith(source: string, target: string, compiled: CompilerOptions): Built {
  const engine = new Engine({
    ...hostOptions(),
    typecheck: "off",
    backends: createBackendRegistry(),
  });
  try {
    const program = engine.compileAot(source, { backend: target, compilerOptions: compiled });
    return { skipped: program.skipped.map((skip) => `${skip.name}: ${skip.reason}`), error: null };
  } catch (error) {
    return { skipped: [], error: messageOf(error) };
  }
}

export function seen(lines: readonly string[], attempts: number, ok: boolean): Observation {
  return { signature: JSON.stringify(lines), lines, attempts, ok };
}

function observationOf(ran: Ran, attempts: number): Observation {
  if (ran.error === null) return seen(ran.printed, attempts, true);
  return seen([...ran.printed, `threw: ${ran.error}`], attempts, false);
}

export function observeInterpreter(source: string): Observation {
  return observationOf(runWith(source, COLD_TIERING, null), 0);
}

export function observeBaseline(source: string): Observation {
  return observationOf(runWith(source, BASELINE_TIERING, null), 0);
}

export function observeJit(source: string, watch: Watch): Observation {
  const counter = new OptBisect(watch.limit);
  const options = compilerOptions(watch.optLevel, { optBisect: counter });
  return observationOf(runWith(source, FORCED_TIERING, options), counter.attempts);
}

export function observeAot(source: string, target: string, watch: Watch): Observation {
  const counter = new OptBisect(watch.limit);
  const built = buildWith(source, target, compilerOptions(watch.optLevel, { optBisect: counter }));
  if (built.error !== null) return seen([`the build threw: ${built.error}`], counter.attempts, false);
  if (built.skipped.length > 0) return seen(built.skipped, counter.attempts, false);
  return seen(["built every function"], counter.attempts, true);
}
