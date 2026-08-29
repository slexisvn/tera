import { useMemo, useState } from "react";
import { comparePin, type CompareKind, type PinnedRun } from "../services/pinned-run";
import type { Stage } from "../types/stage";
import { DiffView } from "./DiffView";

type CompareViewProps = {
  pin: PinnedRun | null;
  stages: readonly Stage[];
  hasRun: boolean;
  matches: boolean;
  onPin: () => void;
  onClear: () => void;
  onSelect: (id: string) => void;
};

const WORDING: Readonly<Record<CompareKind, string>> = {
  same: "identical",
  changed: "rewritten",
  added: "new",
  removed: "gone",
};

function when(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

export function CompareView({
  pin,
  stages,
  hasRun,
  matches,
  onPin,
  onClear,
  onSelect,
}: CompareViewProps) {
  const [open, setOpen] = useState<string | null>(null);
  const report = useMemo(() => (pin === null ? null : comparePin(pin, stages)), [pin, stages]);

  return (
    <div className="compare">
      <div className="compare-bar">
        <button type="button" className="compare-pin" disabled={!hasRun} onClick={onPin}>
          {pin === null ? "Pin this run" : "Pin again"}
        </button>
        {pin !== null && (
          <button type="button" className="compare-clear" onClick={onClear}>
            Forget the pin
          </button>
        )}
        <span className="compare-hint">
          A pin survives a reload, so you can pin a run, edit a pass in the compiler and see exactly
          which stages your edit moved.
        </span>
      </div>

      {pin === null && (
        <p className="console-note">
          Nothing pinned. Pin a run first — after that, every compile is compared against it stage by
          stage.
        </p>
      )}

      {pin !== null && report !== null && (
        <div className="compare-result">
          <div className="compare-head">
            <span className="compare-fact">
              pinned {pin.stages.length} stages · {when(pin.at)}
            </span>
            {!matches && (
              <span className="compare-fact warn">
                the pin was taken with different settings or code
              </span>
            )}
            {pin.withoutText > 0 && (
              <span className="compare-fact">{pin.withoutText} stages pinned without their text</span>
            )}
          </div>
          <div className="compare-totals">
            {(["changed", "added", "removed", "same"] as const).map((kind) => (
              <span key={kind} className={`compare-total ${kind}`}>
                {report.totals[kind]} {WORDING[kind]}
              </span>
            ))}
          </div>
          {report.rows.length === 0 ? (
            <p className="console-note">
              Every stage came out byte for byte the same as the pinned run.
            </p>
          ) : (
            <ul className="compare-list">
              {report.rows.map((entry) => (
                <li key={entry.key}>
                  <button
                    type="button"
                    className={`compare-row kind-${entry.kind}`}
                    onClick={() => setOpen(open === entry.key ? null : entry.key)}
                  >
                    <span className="compare-kind">{WORDING[entry.kind]}</span>
                    <span className="compare-name">{entry.title}</span>
                    <span className="compare-owner">{entry.owner}</span>
                  </button>
                  {open === entry.key && (
                    <div className="compare-diff">
                      {entry.before !== null && entry.after !== null ? (
                        <DiffView before={entry.before} after={entry.after} />
                      ) : (
                        <p className="console-note">
                          {entry.kind === "removed"
                            ? "This stage does not run any more."
                            : entry.kind === "added"
                              ? "This stage is new since the pin."
                              : "The pin was too big to keep this stage's text, so there is nothing to compare it against — pin the run again."}
                        </p>
                      )}
                      {entry.stageId !== null && (
                        <button
                          type="button"
                          className="find-jump"
                          onClick={() => onSelect(entry.stageId!)}
                        >
                          open this stage
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
