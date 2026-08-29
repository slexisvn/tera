import type { RunRequest, TierId, TierKind, TierReport, TierRow } from "../types/stage";
import { messageOf } from "./engine-options";
import {
  observeAot,
  observeBaseline,
  observeInterpreter,
  observeJit,
  type Observation,
} from "./observe";

const LINES_SHOWN = 12;

function row(
  id: TierId,
  label: string,
  kind: TierKind,
  seen: Observation,
  agrees: boolean,
): TierRow {
  const lines = seen.lines.length <= LINES_SHOWN ? seen.lines : seen.lines.slice(0, LINES_SHOWN);
  return { id, label, kind, lines, ok: seen.ok, agrees };
}

export function compareTiers(request: RunRequest): TierReport {
  const started = performance.now();
  const whole = { optLevel: request.optLevel, limit: Number.POSITIVE_INFINITY };

  try {
    const interpreter = observeInterpreter(request.source);
    const agrees = (seen: Observation): boolean => seen.signature === interpreter.signature;
    const rows: TierRow[] = [row("interpreter", "Interpreter only", "ran", interpreter, true)];

    const baseline = observeBaseline(request.source);
    rows.push(row("baseline", "Baseline compiler", "ran", baseline, agrees(baseline)));

    const plain = observeJit(request.source, { optLevel: request.optLevel, limit: 0 });
    rows.push(row("jit-plain", "JIT, no optimization pass", "ran", plain, agrees(plain)));

    const jit = observeJit(request.source, whole);
    rows.push(row("jit", `JIT, -O ${request.optLevel}`, "ran", jit, agrees(jit)));

    if (request.pipeline === "aot") {
      const built = observeAot(request.source, request.target, whole);
      rows.push(row("aot", `AOT build · ${request.target}`, "built", built, built.ok));
    }

    const bad = rows.find((entry) => !entry.agrees) ?? null;
    return {
      rows,
      verdict: bad === null ? "agree" : "disagree",
      firstBad: bad === null ? null : bad.id,
      elapsedMs: performance.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      rows: [],
      verdict: "failed",
      firstBad: null,
      elapsedMs: performance.now() - started,
      error: messageOf(error),
    };
  }
}
