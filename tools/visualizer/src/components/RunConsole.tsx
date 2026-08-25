import { CONSOLE_TABS, wordingOf, type ConsoleTab } from "../config/panes";
import type { Failure, RunStatus } from "../services/run-report";
import type { PipelineId, RunResult } from "../types/stage";
import { Badge, type Badges } from "./Badge";
import { FailureBlock } from "./FailureBlock";
import { RunButton, RUN_SHORTCUT } from "./RunButton";
import { RuntimeTimeline } from "./RuntimeTimeline";

export type RunConsoleProps = {
  result: RunResult;
  failures: readonly Failure[];
  badges: Badges;
  status: RunStatus;
  pipeline: PipelineId;
  busy: boolean;
  ready: boolean;
  hasRun: boolean;
  docked: boolean;
  tab: ConsoleTab;
  onTab: (tab: ConsoleTab) => void;
  onRun: () => void;
  onGoToLine: (line: number) => void;
};

export function RunConsole({
  result,
  failures,
  badges,
  status,
  pipeline,
  busy,
  ready,
  hasRun,
  docked,
  tab,
  onTab,
  onRun,
  onGoToLine,
}: RunConsoleProps) {
  const printed = result.output;

  return (
    <section className="console" aria-label="Program output">
      {docked && (
        <header className="console-head">
          <span className={`run-status tone-${status.tone}`} role="status" aria-live="polite">
            {status.text}
          </span>
          <div className="console-row">
            <RunButton busy={busy} ready={ready} onRun={onRun} />
            <div className="console-tabs" role="group" aria-label="Console tab">
              {CONSOLE_TABS.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  aria-pressed={tab === entry.consoleTab}
                  title={wordingOf(entry.title, pipeline)}
                  onClick={() => onTab(entry.consoleTab)}
                >
                  {wordingOf(entry.label, pipeline)}
                  <Badge badge={badges[entry.id]} />
                </button>
              ))}
            </div>
          </div>
        </header>
      )}

      {tab === "output" && (
        <div className="console-body">
          {printed.length > 0 && (
            <pre className="console-print">
              {printed.map((line, at) => (
                <div key={at}>{line === "" ? " " : line}</div>
              ))}
            </pre>
          )}
          {result.outputDropped > 0 && (
            <p className="console-note">+{result.outputDropped} more lines printed, not shown.</p>
          )}
          {failures.map((failure) => (
            <FailureBlock key={`${failure.source}-${failure.message}`} failure={failure} onGoToLine={onGoToLine} />
          ))}
          {hasRun && printed.length === 0 && failures.length === 0 && (
            <p className="console-note">The program ran and printed nothing.</p>
          )}
          {!hasRun && (
            <p className="console-note">
              Nothing has run yet. Press <strong>Compile &amp; run</strong> ({RUN_SHORTCUT}) to compile
              the code and see what it prints.
            </p>
          )}
          {hasRun && pipeline === "aot" && (
            <p className="console-note">
              AOT builds a binary without running it — this output comes from the engine running the same
              program, so you can check the code you are compiling still does what you meant.
            </p>
          )}
        </div>
      )}

      {tab === "runtime" && (
        <div className="console-body">
          <RuntimeTimeline events={result.events} dropped={result.dropped} pipeline={pipeline} />
        </div>
      )}
    </section>
  );
}
