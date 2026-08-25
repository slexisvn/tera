import { useMemo } from "react";
import { GROUP_ORDER, GROUP_TITLES, type Stage, type StageGroup } from "../types/stage";

type PipelineRailProps = {
  stages: readonly Stage[];
  selectedId: string | null;
  hideUnchanged: boolean;
  onSelect: (id: string) => void;
  onToggleUnchanged: () => void;
};

function delta(stage: Stage): string | null {
  if (stage.metrics === null) return null;
  const change = stage.metrics.nodesAfter - stage.metrics.nodesBefore;
  return change < 0 ? String(change) : `+${change}`;
}

export function PipelineRail({ stages, selectedId, hideUnchanged, onSelect, onToggleUnchanged }: PipelineRailProps) {
  const groups = useMemo(() => {
    const visible = hideUnchanged ? stages.filter((stage) => stage.changed) : stages;
    const buckets = new Map<StageGroup, Stage[]>();
    for (const group of GROUP_ORDER) buckets.set(group, []);
    for (const stage of visible) buckets.get(stage.group)!.push(stage);
    return [...buckets.entries()].filter(([, bucket]) => bucket.length > 0);
  }, [hideUnchanged, stages]);

  const hidden = stages.length - groups.reduce((count, [, bucket]) => count + bucket.length, 0);

  return (
    <nav className="rail" aria-label="Compiler stages">
      <div className="rail-head">
        <span className="rail-count">{stages.length} stages</span>
        <button type="button" aria-pressed={hideUnchanged} onClick={onToggleUnchanged}>
          {hideUnchanged ? `${hidden} hidden` : "hide unchanged"}
        </button>
      </div>
      {groups.map(([group, bucket]) => (
        <section className="rail-group" key={group}>
          <h2>{GROUP_TITLES[group]}</h2>
          <ul>
            {bucket.map((stage) => (
              <li key={stage.id}>
                <button
                  type="button"
                  className={`rail-item${stage.changed ? "" : " quiet"}${stage.id === selectedId ? " active" : ""}`}
                  onClick={() => onSelect(stage.id)}
                >
                  <span className="rail-title">{stage.title}</span>
                  <span className="rail-meta">
                    {delta(stage) !== null && <span className="rail-delta">{delta(stage)}</span>}
                    <span className="rail-sub">{stage.subtitle}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {stages.length === 0 && <p className="rail-empty">Run the source to see the pipeline.</p>}
    </nav>
  );
}
