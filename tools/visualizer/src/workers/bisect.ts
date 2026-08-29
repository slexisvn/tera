import { compilerOptions, OptBisect, type CFGFunction, type PassTraceRecord } from "tera";
import type { BisectResult, RunRequest } from "../types/stage";
import { FORCED_TIERING, messageOf } from "./engine-options";
import {
  buildWith,
  observeAot,
  observeInterpreter,
  observeJit,
  runWith,
  seen,
  type Observation,
} from "./observe";

const JIT_ORACLE = "what the program printed";
const AOT_ORACLE = "whether the build produced every function";
const OUTPUT_SHOWN = 12;

type Culprit = {
  readonly pass: string | null;
  readonly owner: string | null;
};

const NOBODY: Culprit = { pass: null, owner: null };

function nameAt(request: RunRequest, limit: number): Culprit {
  let found: Culprit = NOBODY;
  const options = compilerOptions(request.optLevel, {
    optBisect: new OptBisect(limit - 1),
    passTracer: (traced) => {
      const record = traced as PassTraceRecord<CFGFunction>;
      if (found.pass !== null || !record.skipped) return;
      found = { pass: record.pass, owner: record.graph.name };
    },
  });
  if (request.pipeline === "aot") buildWith(request.source, request.target, options);
  else runWith(request.source, FORCED_TIERING, options);
  return found;
}

function shown(lines: readonly string[]): readonly string[] {
  return lines.length <= OUTPUT_SHOWN ? lines : lines.slice(0, OUTPUT_SHOWN);
}

export function firstBadLimit(total: number, differs: (limit: number) => boolean): number {
  let low = 1;
  let high = total;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (differs(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function bisect(request: RunRequest): BisectResult {
  const started = performance.now();
  const aot = request.pipeline === "aot";
  let compiles = 0;
  const observe = (limit: number): Observation => {
    compiles++;
    const watch = { optLevel: request.optLevel, limit };
    return aot
      ? observeAot(request.source, request.target, watch)
      : observeJit(request.source, watch);
  };

  const report = (
    verdict: BisectResult["verdict"],
    reference: Observation,
    outcome: Observation,
    limit: number,
    named: Culprit,
    error: string | null,
  ): BisectResult => ({
    verdict,
    oracle: aot ? AOT_ORACLE : JIT_ORACLE,
    total: outcome.attempts,
    limit,
    pass: named.pass,
    owner: named.owner,
    reference: shown(reference.lines),
    observed: shown(outcome.lines),
    compiles,
    elapsedMs: performance.now() - started,
    error,
  });

  let full: Observation;
  try {
    full = observe(Number.POSITIVE_INFINITY);
  } catch (error) {
    const nothing = seen([], 0, false);
    return report("failed", nothing, nothing, 0, NOBODY, messageOf(error));
  }
  if (full.attempts === 0) return report("no-passes", full, full, 0, NOBODY, null);

  compiles++;
  const reference = aot
    ? observeAot(request.source, request.target, { optLevel: request.optLevel, limit: 0 })
    : observeInterpreter(request.source);
  if (!aot) {
    const none = observe(0);
    if (none.signature !== reference.signature) {
      return report("before-passes", reference, none, 0, NOBODY, null);
    }
  }
  if (full.signature === reference.signature) {
    return report(reference.ok ? "clean" : "before-passes", reference, full, 0, NOBODY, null);
  }

  const low = firstBadLimit(
    full.attempts,
    (limit) => observe(limit).signature !== reference.signature,
  );

  return report("found", reference, observe(low), low, nameAt(request, low), null);
}
