import { useMemo } from "react";
import { diffIR, summarize } from "../services/ir-diff";
import { IrLine } from "./IrLine";

const MARKS = { same: " ", added: "+", removed: "-", changed: "~", moved: "»" } as const;

const SUMMARY: readonly { kind: "added" | "removed" | "changed" | "moved"; mark: string; label: string }[] = [
  { kind: "added", mark: "+", label: "added" },
  { kind: "removed", mark: "-", label: "removed" },
  { kind: "changed", mark: "~", label: "rewritten" },
  { kind: "moved", mark: "»", label: "moved to another block" },
];

export function DiffView({ before, after, wrap = false }: { before: string | null; after: string; wrap?: boolean }) {
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
        {SUMMARY.filter((entry) => totals[entry.kind] > 0).map((entry) => (
          <span className={entry.kind} key={entry.kind}>
            {entry.mark}
            {totals[entry.kind]} {entry.label}
          </span>
        ))}
        {SUMMARY.every((entry) => totals[entry.kind] === 0) && (
          <span className="diff-none">nothing changed in this graph</span>
        )}
      </div>
      <pre className={`code${wrap ? " wrap" : ""}`}>
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
