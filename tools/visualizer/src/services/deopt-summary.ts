import type { DeoptOrigin, RuntimeEvent } from "../types/stage";

export const REPEATS_BEFORE_GIVING_UP = 3;

export type DeoptGroup = {
  readonly key: string;
  readonly owner: string;
  readonly reason: string;
  readonly node: string | null;
  readonly count: number;
  readonly origin: DeoptOrigin;
  readonly looping: boolean;
};

export type DeoptSummary = {
  readonly groups: readonly DeoptGroup[];
  readonly total: number;
  readonly looping: number;
};

const NOTHING: DeoptSummary = { groups: [], total: 0, looping: 0 };

export function summarizeDeopts(events: readonly RuntimeEvent[]): DeoptSummary {
  const counted = new Map<string, { origin: DeoptOrigin; count: number }>();
  let total = 0;

  for (const event of events) {
    if (event.category !== "deopt" || event.origin === null) continue;
    total++;
    const origin = event.origin;
    const key = `${origin.owner}/${origin.reason}/${origin.node ?? "-"}`;
    const held = counted.get(key);
    if (held === undefined) counted.set(key, { origin, count: 1 });
    else held.count++;
  }
  if (total === 0) return NOTHING;

  const groups = [...counted.entries()]
    .map(([key, held]) => ({
      key,
      owner: held.origin.owner,
      reason: held.origin.reason,
      node: held.origin.node,
      count: held.count,
      origin: held.origin,
      looping: held.count >= REPEATS_BEFORE_GIVING_UP,
    }))
    .sort((left, right) => right.count - left.count);

  return { groups, total, looping: groups.filter((group) => group.looping).length };
}
