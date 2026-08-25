import type { RunResult } from "../types/stage";

const ERROR_POSITION = /\bat (\d+):(\d+)\b/;

export type StatusTone = "idle" | "busy" | "stale" | "failed" | "ok";

export type RunStatus = {
  readonly tone: StatusTone;
  readonly text: string;
};

export type RunState = {
  readonly result: RunResult;
  readonly busy: boolean;
  readonly hasRun: boolean;
  readonly stale: boolean;
};

export type Failure = {
  readonly source: string;
  readonly message: string;
  readonly line: number | null;
};

export function errorLineOf(message: string | null): number | null {
  if (message === null) return null;
  const found = ERROR_POSITION.exec(message);
  return found === null ? null : Number(found[1]);
}

export function statusOf({ result, busy, hasRun, stale }: RunState): RunStatus {
  if (busy) return { tone: "busy", text: "Compiling…" };
  if (!hasRun) return { tone: "idle", text: "not compiled yet" };
  if (result.error !== null || result.runError !== null) {
    return { tone: "failed", text: result.error !== null ? "compile failed" : "threw while running" };
  }
  const ran = `${result.stages.length} stages · ${result.elapsedMs.toFixed(0)}ms`;
  return stale ? { tone: "stale", text: `${ran} · source changed` } : { tone: "ok", text: ran };
}

export function failuresOf(result: RunResult, label: string | null = null): readonly Failure[] {
  const where = (kind: string): string => (label === null ? kind : `${label} · ${kind}`);
  const found: Failure[] = [];
  if (result.error !== null) {
    found.push({ source: where("compiler"), message: result.error, line: errorLineOf(result.error) });
  }
  if (result.runError !== null && result.runError !== result.error) {
    found.push({ source: where("runtime"), message: result.runError, line: errorLineOf(result.runError) });
  }
  return found;
}
