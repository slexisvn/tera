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

function Raw({ stage }: { stage: Stage }) {
  if (stage.kind !== "ir" && stage.kind !== "machine") return <pre className="code">{stage.text}</pre>;
  return (
    <pre className="code">
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
        Runs in: <span className={`tier tier-${note.tier}`}>{note.tier === "both" ? "JIT and AOT" : note.tier.toUpperCase()}</span>
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
};

export function StageViewer({ stage, previous, selectedNode, onSelectNode, onHoverNode }: StageViewerProps) {
  const [tab, setTab] = useState<Tab>("diff");

  if (stage === null) {
    return <section className="viewer viewer-empty">Pick a stage on the left.</section>;
  }

  const drawable = stage.kind === "ir";
  const diffable = drawable || stage.kind === "machine";
  const active = (tab === "graph" && !drawable) || (tab === "diff" && !diffable) ? "raw" : tab;

  return (
    <section className="viewer">
      <header className="viewer-head">
        <div className="viewer-title">
          <h2>{stage.title}</h2>
          <span className="viewer-sub">{stage.subtitle}</span>
        </div>
        <div className="viewer-facts">
          {stage.metrics !== null && (
            <span className="fact">
              nodes {stage.metrics.nodesBefore} → {stage.metrics.nodesAfter}
            </span>
          )}
          <span className={`fact ${stage.changed ? "yes" : "no"}`}>{stage.changed ? "changed" : "unchanged"}</span>
          {stage.invalidated.length > 0 && (
            <span className="fact">invalidated {stage.invalidated.join(" ")}</span>
          )}
        </div>
        <div className="viewer-tabs">
          {TABS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              disabled={entry.id === "graph" ? !drawable : entry.id === "diff" && !diffable}
              aria-pressed={entry.id === active}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>
      {active === "diff" && <DiffView before={previous === null ? null : previous.text} after={stage.text} />}
      {active === "graph" && (
        <GraphView
          text={stage.text}
          before={previous === null ? null : previous.text}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
          onHoverNode={onHoverNode}
        />
      )}
      {active === "raw" && <Raw stage={stage} />}
      {active === "explain" && <Explain stage={stage} />}
    </section>
  );
}
