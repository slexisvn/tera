import { useCallback, useEffect, useMemo, useState } from "react";
import { noteFor } from "../content/passes";
import { fixtureFor } from "../services/fixture";
import type { Stage } from "../types/stage";
import { AllocationView } from "./AllocationView";
import { AnalysesView } from "./AnalysesView";
import { DiffView } from "./DiffView";
import { GraphView, type GraphFocus } from "./GraphView";
import { HistoryView } from "./HistoryView";
import { IrLine } from "./IrLine";
import { RemarkList } from "./RemarkList";

type Tab = "diff" | "graph" | "why" | "history" | "analyses" | "registers" | "raw" | "explain";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "diff", label: "Diff" },
  { id: "graph", label: "Graph" },
  { id: "why", label: "Why" },
  { id: "history", label: "History" },
  { id: "analyses", label: "Analyses" },
  { id: "registers", label: "Registers" },
  { id: "raw", label: "Raw" },
  { id: "explain", label: "Explain" },
];

const WHY_DISABLED: Readonly<Record<Tab, string>> = {
  diff: "There is no earlier version of this stage to compare against",
  graph: "Only SSA stages draw as a graph",
  why: "This pass recorded nothing about the decisions it made",
  history: "Only SSA stages can follow one value from pass to pass",
  analyses: "Only SSA stages carry the analyses a pass reads",
  registers: "Only the register allocator reports where each value ended up",
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
  stages: readonly Stage[];
  previous: Stage | null;
  selectedNode: string | null;
  focus: GraphFocus | null;
  onSelectNode: (key: string | null) => void;
  onHoverNode: (key: string | null) => void;
  onSelectStage: (id: string) => void;
  onSendToLab: () => void;
};

export function StageViewer({
  stage,
  stages,
  previous,
  selectedNode,
  focus,
  onSelectNode,
  onHoverNode,
  onSelectStage,
  onSendToLab,
}: StageViewerProps) {
  const [tab, setTab] = useState<Tab>("diff");
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");

  const fixture = useMemo(
    () => (stage === null ? null : fixtureFor(stage, previous)),
    [previous, stage],
  );

  const copyFixture = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("done");
    } catch {
      setCopied("manual");
    }
  }, []);

  const stageId = stage?.id ?? null;
  useEffect(() => setCopied("idle"), [stageId]);

  const focusAt = focus?.at ?? null;
  useEffect(() => {
    if (focusAt !== null) setTab("graph");
  }, [focusAt]);

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
    why: stage.remarks.length > 0,
    history: stage.kind === "ir",
    analyses: stage.kind === "ir",
    registers: stage.allocation !== null,
    raw: true,
    explain: true,
  };
  const landing: Tab = available.diff ? "diff" : available.graph ? "graph" : "raw";
  const active: Tab = available[tab] ? tab : landing;
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
          <span
            className={`fact ${stage.failed ? "failed" : stage.skipped ? "skipped" : stage.changed ? "yes" : "no"}`}
          >
            {stage.failed
              ? "broke an invariant"
              : stage.skipped
                ? "skipped by bisect"
                : stage.changed
                  ? "changed"
                  : "unchanged"}
          </span>
          {stage.elapsedMs > 0 && (
            <span className="fact" title="How long this pass itself took">
              {stage.elapsedMs >= 10 ? stage.elapsedMs.toFixed(0) : stage.elapsedMs.toFixed(2)}ms
            </span>
          )}
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
              {entry.id === "why" && stage.remarks.length > 0 && (
                <span className="tab-count">{stage.remarks.length}</span>
              )}
            </button>
          ))}
          {fixture !== null && (
            <button
              type="button"
              className="viewer-fixture"
              onClick={() => void copyFixture(fixture)}
              title="Copy this pass and the graph it ran on as a test you can paste into tests/optimizing/passes"
            >
              {copied === "done" ? "copied" : "Copy as test"}
            </button>
          )}
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
      {copied === "manual" && fixture !== null && (
        <div className="fixture">
          <p>The clipboard is not available here — copy this by hand.</p>
          <pre className="code">{fixture}</pre>
        </div>
      )}
      {stage.verification.length > 0 && (
        <div className="verification">
          <h3>The graph broke {stage.verification.length === 1 ? "an invariant" : "invariants"} after this pass</h3>
          <ul>
            {stage.verification.map((problem, at) => (
              <li key={at}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {active === "diff" && (
        <>
          {!stage.changed && stage.remarks.length > 0 && (
            <button type="button" className="why-nudge" onClick={() => setTab("why")}>
              This pass left the graph alone. It recorded {stage.remarks.length}{" "}
              {stage.remarks.length === 1 ? "remark" : "remarks"} saying why —{" "}
              <strong>read them</strong>
            </button>
          )}
          <DiffView before={previous === null ? null : previous.text} after={stage.text} wrap={wrap} />
        </>
      )}
      {active === "analyses" && <AnalysesView stage={stage} stages={stages} />}
      {active === "registers" && stage.allocation !== null && (
        <AllocationView report={stage.allocation} />
      )}
      {active === "history" && (
        <HistoryView
          stages={stages}
          owner={stage.owner}
          node={selectedNode}
          onSelect={onSelectStage}
        />
      )}
      {active === "why" && (
        <RemarkList
          remarks={stage.remarks}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
          onHoverNode={onHoverNode}
        />
      )}
      {active === "graph" && (
        <GraphView
          text={stage.text}
          before={previous === null ? null : previous.text}
          selectedNode={selectedNode}
          focus={focus}
          onSelectNode={onSelectNode}
          onHoverNode={onHoverNode}
        />
      )}
      {active === "raw" && <Raw stage={stage} wrap={wrap} />}
      {active === "explain" && <Explain stage={stage} />}
    </section>
  );
}
