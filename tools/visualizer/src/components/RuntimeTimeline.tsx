import { useMemo, useState } from "react";
import type { PipelineId, RuntimeEvent } from "../types/stage";

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
  pipeline: PipelineId;
};

export const TRACE_LABEL: Readonly<Record<PipelineId, string>> = {
  jit: "JIT runtime",
  aot: "AOT trace",
};

export const TRACE_TITLE: Readonly<Record<PipelineId, string>> = {
  jit: "Tiering, deopt, inline-cache and GC events recorded while the engine ran your program",
  aot: "What the AOT compiler did while it built the binary — it never runs your program",
};

const SPAN_NOTE: Readonly<Record<PipelineId, string>> = {
  jit: "while the engine ran your program",
  aot: "of AOT compilation",
};

const TIER_LANE: Readonly<Record<PipelineId, string>> = {
  jit: "Tiering",
  aot: "Compiler",
};

export function RuntimeTimeline({ events, dropped, pipeline }: RuntimeTimelineProps) {
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
      <p className="console-note">
        Nothing traced yet. For a JIT target this fills with what the engine did while it ran your
        program — tiering it from the interpreter up to the optimizing JIT, and the inline caches, hidden
        classes and collections along the way. For an AOT target the program is never run, so what shows
        up here is the compiler talking instead.
      </p>
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
            {lane.id === "tier" ? TIER_LANE[pipeline] : lane.label}{" "}
            <span className="tl-count">{counts.get(lane.id)}</span>
          </button>
        ))}
        <span className="tl-span">
          {span.toFixed(0)}ms {SPAN_NOTE[pipeline]}
        </span>
      </div>
      <div className="tl-axis" aria-hidden="true">
        {shown.map((event, at) => (
          <span
            key={at}
            className={`tl-dot tl-${laneOf(event.category)}`}
            style={{ left: `${((event.at - origin) / span) * 100}%` }}
          />
        ))}
      </div>
      <ul>
        {shown.map((event, at) => (
          <li key={at}>
            <span className="tl-at">{(event.at - origin).toFixed(1)}ms</span>
            <span className="tl-what">
              <span className={`tl-tag tl-${laneOf(event.category)}`}>{event.category}</span>
              {event.message}
            </span>
          </li>
        ))}
      </ul>
      {Object.entries(dropped).length > 0 && (
        <p className="tl-dropped">
          {Object.entries(dropped)
            .map(([category, count]) => `+${count} ${category}`)
            .join(", ")}{" "}
          not shown
        </p>
      )}
    </div>
  );
}
