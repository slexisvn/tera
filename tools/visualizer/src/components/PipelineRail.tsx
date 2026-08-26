import { useId, useMemo, useState } from "react";
import { noteFor } from "../content/passes";
import { notableOnly, quietCount } from "../services/stage-filter";
import { GROUP_ORDER, GROUP_TITLES, type Stage, type StageGroup } from "../types/stage";

type PipelineRailProps = {
  stages: readonly Stage[];
  selectedId: string | null;
  hideUnchanged: boolean;
  hasRun: boolean;
  onSelect: (id: string) => void;
  onToggleUnchanged: () => void;
};

function delta(stage: Stage): string | null {
  if (stage.metrics === null) return null;
  const change = stage.metrics.nodesAfter - stage.metrics.nodesBefore;
  if (change === 0) return stage.changed ? "rewritten" : "no change";
  return `${change > 0 ? "+" : ""}${change} nodes`;
}

function scopeOf(stage: Stage): string {
  return stage.kind === "ir" ? `fn ${stage.subtitle}` : stage.subtitle;
}

function summaryOf(stage: Stage): string | null {
  if (stage.failed) return "this step threw, so nothing was compiled past the frontend";
  return noteFor(stage.passName)?.what ?? null;
}

export function PipelineRail({
  stages,
  selectedId,
  hideUnchanged,
  hasRun,
  onSelect,
  onToggleUnchanged,
}: PipelineRailProps) {
  const [filter, setFilter] = useState("");
  const filterId = useId();
  const needle = filter.trim().toLowerCase();

  const matched = useMemo(() => {
    if (needle !== "") {
      return stages.filter(
        (stage) =>
          stage.title.toLowerCase().includes(needle) || stage.subtitle.toLowerCase().includes(needle),
      );
    }
    return hideUnchanged ? notableOnly(stages) : stages;
  }, [hideUnchanged, needle, stages]);

  const groups = useMemo(() => {
    const buckets = new Map<StageGroup, Stage[]>();
    for (const group of GROUP_ORDER) buckets.set(group, []);
    for (const stage of matched) buckets.get(stage.group)!.push(stage);
    return [...buckets.entries()].filter(([, bucket]) => bucket.length > 0);
  }, [matched]);

  const quiet = quietCount(stages);

  return (
    <nav className="rail" aria-label="Compiler stages">
      {stages.length > 0 && (
        <div className="rail-head">
          <div className="rail-head-row">
            <span className="rail-count">
              {matched.length} of {stages.length} stages
            </span>
            <button
              type="button"
              aria-pressed={hideUnchanged}
              onClick={onToggleUnchanged}
              title={`Show only the passes that rewrote something or explained why they did not — ${quiet} passes did neither`}
            >
              changed only <span className="rail-toggle-count">{quiet} hidden</span>
            </button>
          </div>
          <label className="visually-hidden" htmlFor={filterId}>
            Filter stages by name
          </label>
          <input
            id={filterId}
            className="rail-filter"
            type="search"
            value={filter}
            placeholder="Filter passes…"
            onChange={(event) => setFilter(event.target.value)}
          />
          <p className="rail-hint">
            <kbd>Alt</kbd>+<kbd>J</kbd>/<kbd>K</kbd> steps through this list
          </p>
        </div>
      )}
      <div className="rail-body">
        {groups.map(([group, bucket]) => (
          <section className="rail-group" key={group}>
            <h2>{GROUP_TITLES[group]}</h2>
            <ul>
              {bucket.map((stage) => (
                <li key={stage.id}>
                <button
                  type="button"
                  className={[
                    "rail-item",
                    stage.changed ? "" : "quiet",
                    stage.failed ? "failed" : "",
                    stage.id === selectedId ? "active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-current={stage.id === selectedId ? "true" : undefined}
                  onClick={() => onSelect(stage.id)}
                >
                  <span className="rail-title">
                    {stage.title}
                    {stage.remarks.length > 0 && (
                      <span
                        className="rail-remarks"
                        title={`${stage.remarks.length} remarks explaining what this pass decided`}
                      >
                        {stage.remarks.length}
                      </span>
                    )}
                  </span>
                  <span className="rail-meta">
                    {delta(stage) !== null && <span className="rail-delta">{delta(stage)}</span>}
                    <span className="rail-sub">{scopeOf(stage)}</span>
                  </span>
                  {summaryOf(stage) !== null && <span className="rail-note">{summaryOf(stage)}</span>}
                </button>
              </li>
              ))}
            </ul>
          </section>
        ))}
        {stages.length === 0 && (
          <p className="rail-empty">
            Every pass the compiler runs will be listed here, in order, once you compile.
          </p>
        )}
        {hasRun && stages.length > 0 && matched.length === 0 && (
          <p className="rail-empty">
            {needle === ""
              ? "No pass rewrote anything, and none of them recorded why."
              : `No stage matches “${filter}”.`}
          </p>
        )}
      </div>
    </nav>
  );
}
