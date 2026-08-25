import { useMemo } from "react";
import { diffIR, summarize } from "../services/ir-diff";
import { IrLine } from "./IrLine";

const MARKS = { same: " ", added: "+", removed: "-", changed: "~", moved: "»" } as const;

export function DiffView({ before, after }: { before: string | null; after: string }) {
  const rows = useMemo(() => diffIR(before ?? "", after), [after, before]);
  const totals = useMemo(() => summarize(rows), [rows]);

  if (before === null) {
    return (
      <div className="viewer-note">
        Nothing ran before this stage, so there is nothing to diff. The Raw tab shows the whole graph.
      </div>
    );
  }

  return (
    <div className="diff">
      <div className="diff-summary">
        <span className="added">+{totals.added} added</span>
        <span className="removed">-{totals.removed} removed</span>
        <span className="changed">~{totals.changed} rewritten</span>
        <span className="moved">»{totals.moved} moved</span>
      </div>
      <pre className="code">
        {rows.map((row) => (
          <div className={`diff-row ${row.kind}`} key={`${row.kind}-${row.key}`}>
            <span className="diff-mark">{MARKS[row.kind]}</span>
            <span className="diff-text">
              <IrLine text={row.text} />
            </span>
            {row.kind === "changed" && row.previous !== null && (
              <span className="diff-was">
                <span className="diff-mark">-</span>
                <span className="diff-text">
                  <IrLine text={row.previous} />
                </span>
              </span>
            )}
            {row.kind === "moved" && <span className="diff-note">moved out of {row.movedFrom ?? "the header"}</span>}
          </div>
        ))}
      </pre>
    </div>
  );
}
