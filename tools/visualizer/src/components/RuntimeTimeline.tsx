import { useMemo, useState } from "react";
import type { RuntimeEvent } from "../types/stage";

const LANES: readonly { id: string; label: string; matches: readonly string[] }[] = [
  { id: "tier", label: "Tiering", matches: ["jit"] },
  { id: "deopt", label: "Deopt", matches: ["deopt"] },
  { id: "feedback", label: "Feedback", matches: ["feedback"] },
  { id: "ic", label: "Inline caches", matches: ["ic"] },
  { id: "hidden_class", label: "Hidden classes", matches: ["hidden_class"] },
  { id: "gc", label: "GC", matches: ["gc"] },
  { id: "other", label: "Other", matches: [] },
];

function laneOf(category: string): string {
  return LANES.find((lane) => lane.matches.includes(category))?.id ?? "other";
}

type RuntimeTimelineProps = {
  events: readonly RuntimeEvent[];
  dropped: Readonly<Record<string, number>>;
};

export function RuntimeTimeline({ events, dropped }: RuntimeTimelineProps) {
  const [muted, setMuted] = useState<ReadonlySet<string>>(() => new Set());

  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const event of events) {
      const lane = laneOf(event.category);
      tally.set(lane, (tally.get(lane) ?? 0) + 1);
    }
    return tally;
  }, [events]);

  const shown = useMemo(
    () => events.filter((event) => !muted.has(laneOf(event.category))),
    [events, muted],
  );

  if (events.length === 0) {
    return (
      <div className="timeline timeline-empty">
        No runtime events. AOT compiles without ever running the program, so this lane stays empty —
        that is the whole difference from the JIT.
      </div>
    );
  }

  const origin = events[0]!.at;
  const span = Math.max(1, events[events.length - 1]!.at - origin);
  const toggle = (lane: string): void =>
    setMuted((current) => {
      const next = new Set(current);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });

  return (
    <div className="timeline">
      <div className="tl-lanes">
        {LANES.filter((lane) => (counts.get(lane.id) ?? 0) > 0).map((lane) => (
          <button
            type="button"
            key={lane.id}
            className={`tl-lane tl-${lane.id}`}
            aria-pressed={!muted.has(lane.id)}
            onClick={() => toggle(lane.id)}
          >
            {lane.label} <span className="tl-count">{counts.get(lane.id)}</span>
          </button>
        ))}
        {Object.entries(dropped).map(([category, count]) => (
          <span className="tl-dropped" key={category}>
            +{count} {category} not shown
          </span>
        ))}
        <span className="tl-span">{span.toFixed(0)}ms total</span>
      </div>
      <ul>
        {shown.map((event, at) => (
          <li key={at}>
            <span className="tl-at">{(event.at - origin).toFixed(1)}ms</span>
            <span className="tl-bar" aria-hidden="true">
              <span className={`tl-dot tl-${laneOf(event.category)}`} style={{ left: `${((event.at - origin) / span) * 100}%` }} />
            </span>
            <span className={`tl-tag tl-${laneOf(event.category)}`}>{event.category}</span>
            <span className="tl-message">{event.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
