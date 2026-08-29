import type { Stage } from "../types/stage";

export type PassCost = {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly elapsedMs: number;
  readonly changed: boolean;
};

export type CostReport = {
  readonly measured: number;
  readonly total: number;
  readonly wasted: number;
  readonly idle: number;
  readonly slowest: readonly PassCost[];
};

const NOTHING: CostReport = { measured: 0, total: 0, wasted: 0, idle: 0, slowest: [] };

export function costOf(stages: readonly Stage[], keep = 12): CostReport {
  const timed = stages.filter((stage) => stage.elapsedMs > 0 && !stage.skipped);
  if (timed.length === 0) return NOTHING;
  let total = 0;
  let wasted = 0;
  let idle = 0;
  for (const stage of timed) {
    total += stage.elapsedMs;
    if (stage.changed) continue;
    wasted += stage.elapsedMs;
    idle++;
  }
  const slowest = [...timed]
    .sort((left, right) => right.elapsedMs - left.elapsedMs)
    .slice(0, keep)
    .map((stage) => ({
      id: stage.id,
      title: stage.title,
      owner: stage.owner,
      elapsedMs: stage.elapsedMs,
      changed: stage.changed,
    }));
  return { measured: timed.length, total, wasted, idle, slowest };
}
