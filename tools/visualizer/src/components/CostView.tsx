import { useMemo } from "react";
import { costOf } from "../services/pass-cost";
import type { Stage } from "../types/stage";

type CostViewProps = {
  stages: readonly Stage[];
  hasRun: boolean;
  onSelect: (id: string) => void;
};

function ms(value: number): string {
  return value >= 10 ? `${value.toFixed(0)}ms` : `${value.toFixed(2)}ms`;
}

export function CostView({ stages, hasRun, onSelect }: CostViewProps) {
  const report = useMemo(() => costOf(stages), [stages]);

  if (!hasRun) {
    return <p className="console-note">Compile something and this lists where the compile time went.</p>;
  }
  if (report.measured === 0) {
    return (
      <p className="console-note">
        No pass reported a time. Only passes that run through the pass manager are timed — the
        frontend, module lowering and code generation are not.
      </p>
    );
  }

  const worst = report.slowest[0]?.elapsedMs ?? 1;

  return (
    <div className="cost">
      <div className="cost-head">
        <span className="cost-fact" title="Time inside the passes themselves, not the whole compile">
          {ms(report.total)} in {report.measured} passes
        </span>
        <span
          className={`cost-fact${report.wasted > 0 ? " waste" : ""}`}
          title="Time spent by passes that looked at the graph and left it exactly as it was"
        >
          {ms(report.wasted)} in {report.idle} that changed nothing
        </span>
      </div>
      <ol className="cost-list">
        {report.slowest.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={`cost-row${entry.changed ? "" : " idle"}`}
              onClick={() => onSelect(entry.id)}
              title={`Open ${entry.title} on ${entry.owner}${entry.changed ? "" : " — it left the graph exactly as it was"}`}
            >
              <span className="cost-bar" style={{ width: `${(entry.elapsedMs / worst) * 100}%` }} />
              <span className="cost-name">{entry.title}</span>
              <span className="cost-owner">
                {entry.owner}
                {!entry.changed && <span className="cost-idle">no change</span>}
              </span>
              <span className="cost-ms">{ms(entry.elapsedMs)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
