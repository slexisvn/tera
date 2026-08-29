import { useMemo, useState } from "react";
import { historyOf, type MomentKind } from "../services/node-history";
import type { Stage } from "../types/stage";

type HistoryViewProps = {
  stages: readonly Stage[];
  owner: string;
  node: string | null;
  onSelect: (id: string) => void;
};

const WORDING: Readonly<Record<MomentKind, string>> = {
  born: "created",
  rewritten: "rewritten",
  moved: "moved",
  held: "untouched",
  gone: "deleted",
};

export function HistoryView({ stages, owner, node, onSelect }: HistoryViewProps) {
  const [untouched, setUntouched] = useState(false);
  const history = useMemo(
    () => (node === null ? null : historyOf(stages, owner, node)),
    [node, owner, stages],
  );

  if (history === null) {
    return (
      <div className="viewer-note">
        Pick a value in the graph or in a remark, and this follows it through every pass that ran on{" "}
        <code>{owner}</code> — where it was created, rewritten, moved between blocks and deleted.
      </div>
    );
  }

  if (history.moments.length === 0) {
    return (
      <div className="viewer-note">
        <code>{node}</code> never appears in <code>{owner}</code> — it belongs to another function.
        Pick a value in this graph to follow it.
      </div>
    );
  }

  const shown = untouched
    ? history.moments
    : history.moments.filter((moment) => moment.kind !== "held");

  return (
    <div className="history">
      <div className="history-head">
        <span className="history-fact">
          <code>{history.node}</code> in {owner}
        </span>
        <span className="history-fact">
          {history.bornIn === null ? "already there at the start" : `created by ${history.bornIn.title}`}
        </span>
        <span className={`history-fact${history.goneIn === null ? "" : " gone"}`}>
          {history.goneIn === null ? "still there at the end" : `deleted by ${history.goneIn.title}`}
        </span>
        <button
          type="button"
          className="history-toggle"
          aria-pressed={untouched}
          onClick={() => setUntouched((on) => !on)}
          title="Also list the passes that left this value exactly as it was"
        >
          {untouched ? "hide untouched" : "show untouched"}
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="viewer-note">
          No pass touched <code>{history.node}</code> after it appeared.
        </p>
      ) : (
        <ol className="history-list">
          {shown.map((moment, at) => (
            <li key={`${moment.stageId}-${at}`}>
              <button
                type="button"
                className={`history-row kind-${moment.kind}`}
                onClick={() => onSelect(moment.stageId)}
                title={`Open ${moment.title}`}
              >
                <span className="history-kind">{WORDING[moment.kind]}</span>
                <span className="history-pass">{moment.title}</span>
                {moment.block !== null && <span className="history-block">{moment.block}</span>}
                <code className="history-text">{moment.text ?? ""}</code>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
