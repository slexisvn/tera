import { useState } from "react";
import { noteFor } from "../content/passes";
import type { Stage } from "../types/stage";
import { DiffView } from "./DiffView";
import { GraphView } from "./GraphView";
import { IrLine } from "./IrLine";

type Tab = "diff" | "graph" | "raw" | "explain";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "diff", label: "Diff" },
  { id: "graph", label: "Graph" },
  { id: "raw", label: "Raw" },
  { id: "explain", label: "Explain" },
];

const WHY_DISABLED: Readonly<Record<Tab, string>> = {
  diff: "There is no earlier version of this stage to compare against",
  graph: "Only SSA stages draw as a graph",
  raw: "",
  explain: "",
};

function Raw({ stage, wrap }: { stage: Stage; wrap: boolean }) {
  const className = `code${wrap ? " wrap" : ""}`;
  if (stage.kind !== "ir" && stage.kind !== "machine") return <pre className={className}>{stage.text}</pre>;
  return (
    <pre className={className}>
      {stage.text.split("\n").map((line, at) => (
        <div key={at}>
          <IrLine text={line} />
        </div>
      ))}
    </pre>
  );
}

function Explain({ stage }: { stage: Stage }) {
  const note = noteFor(stage.passName);
  if (note === null) {
    return (
      <div className="viewer-note">
        No note written for <code>{stage.passName ?? stage.title}</code> yet.
      </div>
    );
  }
  return (
    <div className="explain">
      <p className="explain-what">{note.what}</p>
      <p className="explain-why">
        <strong>Why:</strong> {note.why}
      </p>
      {note.rerun !== undefined && <p className="explain-rerun">{note.rerun}</p>}
      <p className="explain-tier">
        Does its work in:{" "}
        <span className={`tier tier-${note.tier}`}>
          {note.tier === "both" ? "JIT and AOT" : note.tier.toUpperCase()}
        </span>
      </p>
      {note.source !== undefined && <code className="explain-source">{note.source}</code>}
    </div>
  );
}

type StageViewerProps = {
  stage: Stage | null;
  previous: Stage | null;
  selectedNode: string | null;
  onSelectNode: (key: string | null) => void;
  onHoverNode: (key: string | null) => void;
  onSendToLab: () => void;
};

export function StageViewer({
  stage,
  previous,
  selectedNode,
  onSelectNode,
  onHoverNode,
  onSendToLab,
}: StageViewerProps) {
  const [tab, setTab] = useState<Tab>("diff");
  const [wrap, setWrap] = useState(false);

  if (stage === null) {
    return (
      <section className="viewer viewer-empty">
        Pick a stage from the list to see what it rewrote.
      </section>
    );
  }

  const available: Readonly<Record<Tab, boolean>> = {
    diff: (stage.kind === "ir" || stage.kind === "machine") && previous !== null,
    graph: stage.kind === "ir",
    raw: true,
    explain: true,
  };
  const active: Tab = available[tab] ? tab : available.diff ? "diff" : available.graph ? "graph" : "raw";
  const showsCode = active === "raw" || active === "diff";

  return (
    <section className="viewer">
      <header className="viewer-head">
        <div className="viewer-title">
          <h2>{stage.title}</h2>
          <span className="viewer-sub">{stage.subtitle}</span>
        </div>
        <div className="viewer-facts">
          {stage.metrics !== null && (
            <span className="fact" title="Nodes in the graph before and after this pass ran">
              nodes {stage.metrics.nodesBefore} → {stage.metrics.nodesAfter}
            </span>
          )}
          <span className={`fact ${stage.failed ? "failed" : stage.changed ? "yes" : "no"}`}>
            {stage.failed ? "failed" : stage.changed ? "changed" : "unchanged"}
          </span>
          {stage.invalidated.length > 0 && (
            <span
              className="fact"
              title="Cached analyses this pass invalidated — whatever needs them next has to recompute them."
            >
              invalidated {stage.invalidated.join(" ")}
            </span>
          )}
        </div>
        <div className="viewer-tabs">
          {showsCode && (
            <button
              type="button"
              className="wrap-toggle"
              aria-pressed={wrap}
              onClick={() => setWrap((on) => !on)}
              title="Wrap long lines instead of scrolling sideways"
            >
              wrap
            </button>
          )}
          {TABS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              disabled={!available[entry.id]}
              title={available[entry.id] ? undefined : WHY_DISABLED[entry.id]}
              aria-pressed={entry.id === active}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
          {stage.kind === "ir" && (
            <button
              type="button"
              className="viewer-send"
              onClick={onSendToLab}
              title="Open this graph in the IR lab and run a single pass over it by hand"
            >
              Send to IR lab
            </button>
          )}
        </div>
      </header>
      {active === "diff" && <DiffView before={previous === null ? null : previous.text} after={stage.text} wrap={wrap} />}
      {active === "graph" && (
        <GraphView
          text={stage.text}
          before={previous === null ? null : previous.text}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
          onHoverNode={onHoverNode}
        />
      )}
      {active === "raw" && <Raw stage={stage} wrap={wrap} />}
      {active === "explain" && <Explain stage={stage} />}
    </section>
  );
}
