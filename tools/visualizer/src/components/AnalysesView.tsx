import { useMemo } from "react";
import { analysisHistory, type AnalysisUse } from "../services/analysis-history";
import { dominanceOf, loopForestOf, type Loop } from "../services/cfg-analysis";
import { parseGraphText } from "../services/ir-graph";
import type { Stage } from "../types/stage";

const ANALYSIS_NOTES: Readonly<Record<string, string>> = {
  dominance: "which block is guaranteed to have run before which — every question about safety to move code starts here",
  loops: "the loop nest: which blocks belong to which loop, and how deeply",
  "points-to": "which allocations a value can refer to, and whether any of them escapes",
  "mod-ref": "which operations can write memory another one reads",
  "type-inference": "the type each value is known to hold",
};

function LoopTree({ loops }: { loops: readonly Loop[] }) {
  return (
    <ul className="loop-tree">
      {loops.map((loop) => (
        <li key={loop.header}>
          <span className="loop-header">{loop.header}</span>
          <span className="loop-facts">
            {loop.blocks.length} blocks · back edge from {loop.latches.join(", ")}
            {loop.depth > 0 && ` · depth ${loop.depth}`}
          </span>
          {loop.children.length > 0 && <LoopTree loops={loop.children} />}
        </li>
      ))}
    </ul>
  );
}

function DomTree({
  label,
  childrenOf,
  seen,
}: {
  label: string;
  childrenOf: (label: string) => readonly string[];
  seen: ReadonlySet<string>;
}) {
  if (seen.has(label)) return <li className="dom-node">{label} (already shown)</li>;
  const walked = new Set(seen).add(label);
  const children = childrenOf(label);
  return (
    <li className="dom-node">
      <span>{label}</span>
      {children.length > 0 && (
        <ul>
          {children.map((child) => (
            <DomTree key={child} label={child} childrenOf={childrenOf} seen={walked} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Analyses({ names, tone }: { names: readonly string[]; tone: string }) {
  if (names.length === 0) return <span className="analysis-none">nothing</span>;
  return (
    <span className="analysis-list">
      {names.map((name) => (
        <span className={`analysis-chip ${tone}`} key={name} title={ANALYSIS_NOTES[name] ?? name}>
          {name}
        </span>
      ))}
    </span>
  );
}

function Provenance({ use }: { use: AnalysisUse }) {
  if (use.invalidatedBy !== null) {
    return (
      <span className="analysis-story">
        recomputed here — <strong>{use.invalidatedBy}</strong> threw it away {use.passesAgo} passes back
      </span>
    );
  }
  if (use.recomputed) {
    return <span className="analysis-story">computed here for the first time</span>;
  }
  return (
    <span className="analysis-story reused">
      reused — nothing has invalidated it in {use.passesAgo} passes
    </span>
  );
}

export function AnalysesView({ stage, stages }: { stage: Stage; stages: readonly Stage[] }) {
  const history = useMemo(() => analysisHistory(stages, stage), [stage, stages]);
  const model = useMemo(() => parseGraphText(stage.text), [stage.text]);
  const dominance = useMemo(() => (model === null ? null : dominanceOf(model)), [model]);
  const loops = useMemo(
    () => (model === null || dominance === null ? [] : loopForestOf(model, dominance)),
    [dominance, model],
  );

  return (
    <div className="analyses">
      <section>
        <h3>What this pass asked for</h3>
        {history.length === 0 ? (
          <p className="analyses-line">
            <Analyses names={[]} tone="required" />
          </p>
        ) : (
          <ul className="analysis-uses">
            {history.map((use) => (
              <li key={use.name}>
                <span className="analysis-chip required" title={ANALYSIS_NOTES[use.name] ?? use.name}>
                  {use.name}
                </span>
                <Provenance use={use} />
              </li>
            ))}
          </ul>
        )}
        <p className="analyses-note">
          The pass manager computes these before the pass runs, and reuses whatever is still valid
          from an earlier pass. That cache is the whole reason pass order matters: a pass that
          invalidates control flow makes everyone after it pay to rebuild it.
        </p>
      </section>

      <section>
        <h3>What it threw away</h3>
        <p className="analyses-line">
          <Analyses names={stage.invalidated} tone="invalidated" />
        </p>
        <p className="analyses-note">
          Everything listed here has to be recomputed by whoever needs it next. A pass that rewrites
          control flow invalidates almost everything; one that only edits values inside a block keeps
          dominance and the loop nest alive.
        </p>
      </section>

      {dominance !== null && model !== null && (
        <>
          <section>
            <h3>Dominator tree at this point</h3>
            <ul className="dom-tree">
              {dominance.order.length === 0 ? (
                <li className="dom-node">no reachable block</li>
              ) : (
                <DomTree
                  label={dominance.order[0]!}
                  childrenOf={dominance.childrenOf}
                  seen={new Set()}
                />
              )}
            </ul>
            <p className="analyses-note">
              A block's parent here is the last block that every path to it must pass through. Code
              can only be hoisted from a block up to somewhere on this chain.
            </p>
          </section>

          <section>
            <h3>Loop nest at this point</h3>
            {loops.length === 0 ? (
              <p className="analysis-none">no loop — no back edge reaches a block that dominates it</p>
            ) : (
              <LoopTree loops={loops} />
            )}
          </section>
        </>
      )}
    </div>
  );
}
