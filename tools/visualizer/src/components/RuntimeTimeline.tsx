import { useMemo, useState } from "react";
import { summarizeDeopts, type DeoptGroup } from "../services/deopt-summary";
import type { DeoptTarget } from "../services/deopt-link";
import type { DeoptOrigin, PipelineId, RuntimeEvent } from "../types/stage";

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
  onOpenDeopt: (origin: DeoptOrigin) => void;
  resolveDeopt: (origin: DeoptOrigin) => DeoptTarget | null;
};

const RECOMPILED =
  "The graph on screen is a fresh optimisation of the same function, so its value numbers are not the ones the failing code used.";

function originLabel(origin: DeoptOrigin, target: DeoptTarget | null): string {
  if (target === null) return "no graph";
  if (target.match === "node") {
    return origin.opcode === null ? target.node! : `${target.node} ${origin.opcode}`;
  }
  if (target.match === "line") return `line ${target.line}`;
  if (target.match === "retired") return "guard is gone";
  return "open graph";
}

function originTitle(origin: DeoptOrigin, target: DeoptTarget | null): string {
  if (target === null) {
    return `Nothing was compiled for ${origin.owner}, so there is no graph to open`;
  }
  if (target.match === "node") {
    return `Open the graph at ${target.node}, the ${origin.opcode ?? "guard"} whose failure sent this function back to the interpreter`;
  }
  if (target.match === "line") {
    return `${RECOMPILED} Opening the one ${origin.opcode ?? "guard"} it has on line ${target.line}, which is where the failing guard stood.`;
  }
  if (target.match === "retired") {
    return `The ${origin.opcode} that failed is not in this graph at all: once the deopt taught the optimizer that its speculation was wrong, it stopped emitting that guard. Opening the graph at line ${target.line}, where the guard used to stand.`;
  }
  return `${RECOMPILED} Opening the last graph of ${origin.owner} without picking a node, because nothing in it lines up with the failing guard.`;
}

const SPAN_NOTE: Readonly<Record<PipelineId, string>> = {
  jit: "while the engine ran your program",
  aot: "of AOT compilation",
};

const TIER_LANE: Readonly<Record<PipelineId, string>> = {
  jit: "Tiering",
  aot: "Compiler",
};

export function RuntimeTimeline({
  events,
  dropped,
  pipeline,
  onOpenDeopt,
  resolveDeopt,
}: RuntimeTimelineProps) {
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

  const deopts = useMemo(() => summarizeDeopts(events), [events]);

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
      {deopts.total > 0 && (
        <section className="deopts">
          <h3>
            {deopts.total} {deopts.total === 1 ? "deopt" : "deopts"} in {deopts.groups.length}{" "}
            {deopts.groups.length === 1 ? "place" : "places"}
            {deopts.looping > 0 && (
              <span className="deopt-loop">
                {deopts.looping} repeating — the engine gives up optimizing after that
              </span>
            )}
          </h3>
          <ul>
            {deopts.groups.map((group) => (
              <DeoptRow
                key={group.key}
                group={group}
                target={resolveDeopt(group.origin)}
                onOpen={onOpenDeopt}
              />
            ))}
          </ul>
        </section>
      )}
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
              {event.origin !== null && (
                <OriginButton
                  origin={event.origin}
                  target={resolveDeopt(event.origin)}
                  onOpen={onOpenDeopt}
                />
              )}
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

type DeoptRowProps = {
  group: DeoptGroup;
  target: DeoptTarget | null;
  onOpen: (origin: DeoptOrigin) => void;
};

function DeoptRow({ group, target, onOpen }: DeoptRowProps) {
  return (
    <li className={group.looping ? "looping" : undefined}>
      <span className="deopt-count">{group.count}x</span>
      <span className="deopt-owner">{group.owner}</span>
      <span className="deopt-reason">{group.reason}</span>
      <OriginButton origin={group.origin} target={target} onOpen={onOpen} />
    </li>
  );
}

type OriginButtonProps = {
  origin: DeoptOrigin;
  target: DeoptTarget | null;
  onOpen: (origin: DeoptOrigin) => void;
};

function OriginButton({ origin, target, onOpen }: OriginButtonProps) {
  return (
    <button
      type="button"
      className={`tl-origin${target !== null && target.match !== "node" ? " approximate" : ""}`}
      disabled={target === null}
      title={originTitle(origin, target)}
      onClick={() => onOpen(origin)}
    >
      {originLabel(origin, target)}
    </button>
  );
}
