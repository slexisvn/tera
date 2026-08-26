import { useMemo, useState } from "react";
import type { AllocationIntervalReport, AllocationReport } from "tera";

const ROW = 18;
const HEAD = 26;
const LABELS = 88;
const RIGHT = 12;
const TRACK = 620;

type Filter = "all" | "spilled" | "virtual";

const FILTERS: readonly { id: Filter; label: string; title: string }[] = [
  { id: "all", label: "everything", title: "Every live range, including the fixed physical registers the ABI pins" },
  { id: "virtual", label: "virtual only", title: "Only the values the allocator was free to place" },
  { id: "spilled", label: "spilled only", title: "Only the values that lost their register and went to the stack" },
];

function keep(interval: AllocationIntervalReport, filter: Filter): boolean {
  if (filter === "spilled") return interval.spilled;
  if (filter === "virtual") return interval.kind === "virtual";
  return true;
}

function toneOf(interval: AllocationIntervalReport): string {
  if (interval.spilled) return "spilled";
  if (interval.kind === "physical") return "fixed";
  return interval.assigned === null ? "unplaced" : "placed";
}

function whereOf(interval: AllocationIntervalReport): string {
  if (interval.spilled) return interval.spillSlot === null ? "stack" : `slot ${interval.spillSlot}`;
  return interval.assigned ?? "—";
}

export function AllocationView({ report }: { report: AllocationReport }) {
  const [filter, setFilter] = useState<Filter>("virtual");

  const shown = useMemo(
    () => report.intervals.filter((interval) => keep(interval, filter)),
    [filter, report.intervals],
  );

  const span = Math.max(1, report.last - report.first);
  const at = (position: number): number => LABELS + ((position - report.first) / span) * TRACK;
  const height = HEAD + Math.max(1, shown.length) * ROW + 8;

  return (
    <div className="alloc">
      <div className="alloc-head">
        <span className="alloc-fact" title="Values the allocator had to move to the stack because no register was free">
          {report.spilledCount} spilled
        </span>
        <span className="alloc-fact" title="Live ranges the allocator cut in two so the halves could live in different places">
          {report.splitCount} split
        </span>
        <span className="alloc-fact" title="Callee-saved registers this function used, so its prologue must preserve them">
          saves {report.usedCalleeSaved.length === 0 ? "nothing" : report.usedCalleeSaved.join(" ")}
        </span>
        <div className="alloc-filters" role="group" aria-label="Which live ranges to show">
          {FILTERS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              title={entry.title}
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="viewer-note">No live range matches this filter.</p>
      ) : (
        <div className="alloc-chart">
          <svg viewBox={`0 0 ${LABELS + TRACK + RIGHT} ${height}`} role="img" width="100%">
            <title>Live ranges against instruction positions</title>
            {report.blocks.map((block) => (
              <g className="alloc-block" key={block.label}>
                <line x1={at(block.from)} y1={HEAD - 8} x2={at(block.from)} y2={height} />
                <text x={at(block.from) + 3} y={HEAD - 12}>
                  {block.label}
                </text>
              </g>
            ))}
            {shown.map((interval, row) => {
              const y = HEAD + row * ROW;
              return (
                <g className={`alloc-row tone-${toneOf(interval)}`} key={`${interval.register}-${row}`}>
                  <text className="alloc-name" x={0} y={y + 11}>
                    {interval.register}
                  </text>
                  <text className="alloc-where" x={LABELS - 6} y={y + 11} textAnchor="end">
                    {whereOf(interval)}
                  </text>
                  {interval.ranges.map((range, index) => (
                    <rect
                      className="alloc-range"
                      key={index}
                      x={at(range.from)}
                      y={y + 3}
                      width={Math.max(2, at(range.to) - at(range.from))}
                      height={ROW - 7}
                      rx={2}
                    >
                      <title>{`${interval.register} live from ${range.from} to ${range.to}`}</title>
                    </rect>
                  ))}
                  {interval.uses.map((position, index) => (
                    <circle className="alloc-use" key={index} cx={at(position)} cy={y + ROW / 2} r={2} />
                  ))}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <p className="alloc-legend">
        Each bar is one value's live range across the instruction stream; a dot is a point where the
        value is read or written. Two values can share a register exactly when their bars do not
        overlap — which is the whole job. A red bar lost that competition and lives on the stack, so
        every dot on it is a load or a store.
      </p>
    </div>
  );
}
