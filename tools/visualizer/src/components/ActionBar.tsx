import type { RunStatus } from "../services/run-report";
import { RunButton } from "./RunButton";

type ActionBarProps = {
  status: RunStatus;
  busy: boolean;
  ready: boolean;
  onRun: () => void;
};

export function ActionBar({ status, busy, ready, onRun }: ActionBarProps) {
  return (
    <div className="action-bar" data-region="bar">
      <span className={`run-status tone-${status.tone}`} role="status" aria-live="polite">
        {status.text}
      </span>
      <RunButton busy={busy} ready={ready} onRun={onRun} />
    </div>
  );
}
