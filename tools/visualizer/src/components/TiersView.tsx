import type { TierReport, TierRow } from "../types/stage";

type TiersViewProps = {
  report: TierReport | null;
  busy: boolean;
  ready: boolean;
  stale: boolean;
  onRun: () => void;
  onBisect: () => void;
};

function verdictOf(row: TierRow): string {
  if (row.id === "interpreter") return "reference";
  if (row.kind === "built") return row.ok ? "built" : "failed";
  return row.agrees ? "agrees" : "differs";
}

function Row({ row }: { row: TierRow }) {
  const tone = row.id === "interpreter" ? "reference" : row.agrees ? "same" : "different";
  return (
    <li className={`tier-row${row.agrees ? "" : " off"}`}>
      <div className="tier-head">
        <span className="tier-label">{row.label}</span>
        <span className={`tier-verdict ${tone}`}>{verdictOf(row)}</span>
      </div>
      <pre className="tier-out">{row.lines.join("\n") || "(printed nothing)"}</pre>
    </li>
  );
}

function headlineOf(report: TierReport): string {
  if (report.verdict === "failed") return "The comparison could not finish";
  if (report.verdict === "agree") return "Every tier gives the same answer";
  const bad = report.rows.find((row) => row.id === report.firstBad);
  return `${bad?.label ?? "A tier"} does not match the interpreter`;
}

export function TiersView({ report, busy, ready, stale, onRun, onBisect }: TiersViewProps) {
  const bisectable =
    report !== null && (report.firstBad === "jit" || report.firstBad === "aot");

  return (
    <div className="tiers">
      <div className="tiers-bar">
        <button type="button" className="tiers-run" disabled={!ready || busy} onClick={onRun}>
          {busy ? "Running…" : "Run every tier"}
        </button>
        <span className="tiers-hint">
          Runs this program four ways — interpreter, baseline, JIT with no optimization pass, and the
          JIT you selected — and compares what each one printed. The interpreter is the reference.
        </span>
      </div>

      {report === null && !busy && (
        <p className="console-note">
          Nothing compared yet. When two tiers print different things, the tier that differs is the
          one carrying the bug.
        </p>
      )}

      {report !== null && (
        <div className={`tiers-result verdict-${report.verdict}`} data-stale={stale || undefined}>
          {stale && (
            <p className="result-stale">
              The code changed since this comparison — run it again before trusting it.
            </p>
          )}
          <h3>{headlineOf(report)}</h3>
          {report.error !== null && <p className="bisect-lead bad">{report.error}</p>}
          {report.verdict === "disagree" && (
            <p className="bisect-lead">
              {report.firstBad === "baseline"
                ? "The baseline compiler already changes the answer, so the optimizing JIT is not the one to look at."
                : report.firstBad === "jit-plain"
                  ? "The JIT is wrong before a single optimization pass runs — look at the IR builder, the deopt path or the wasm backend."
                  : "The tiers below the optimizing JIT agree, so an optimization pass is the likely culprit."}
              {bisectable && (
                <button type="button" className="bisect-open" onClick={onBisect}>
                  Bisect the passes
                </button>
              )}
            </p>
          )}
          <ul className="tiers-list">
            {report.rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ul>
          <p className="bisect-cost">
            {report.rows.length} tiers · {report.elapsedMs.toFixed(0)}ms
          </p>
        </div>
      )}
    </div>
  );
}
