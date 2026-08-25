import { useState } from "react";
import { failuresOf, statusOf, type Failure } from "../services/run-report";
import type { PipelineId, RunResult } from "../types/stage";
import { RunButton, RUN_SHORTCUT } from "./RunButton";
import { RuntimeTimeline, TRACE_LABEL, TRACE_TITLE } from "./RuntimeTimeline";

type ConsoleTab = "output" | "runtime";

export type ConsoleRun = {
  readonly label: string | null;
  readonly result: RunResult;
};

export type RunConsoleProps = {
  runs: readonly ConsoleRun[];
  pipeline: PipelineId;
  busy: boolean;
  hasRun: boolean;
  stale: boolean;
  onRun: () => void;
  onGoToLine: (line: number) => void;
};

function FailureBlock({ failure, onGoToLine }: { failure: Failure; onGoToLine: (line: number) => void }) {
  const body = (
    <>
      <span className="failure-source">{failure.source}</span>
      <span className="failure-message">{failure.message}</span>
    </>
  );
  if (failure.line === null) return <div className="failure">{body}</div>;
  return (
    <button type="button" className="failure" onClick={() => onGoToLine(failure.line!)}>
      {body}
      <span className="failure-go">go to line {failure.line}</span>
    </button>
  );
}

export function RunConsole({
  runs,
  pipeline,
  busy,
  hasRun,
  stale,
  onRun,
  onGoToLine,
}: RunConsoleProps) {
  const [tab, setTab] = useState<ConsoleTab>("output");
  const [open, setOpen] = useState(true);

  const primary = runs[0]!.result;
  const status = statusOf({ result: primary, busy, hasRun, stale });
  const failures = runs.flatMap((run) => failuresOf(run.result, run.label));
  const printed = primary.output;

  return (
    <section className={`console${open ? "" : " shut"}`} aria-label="Program output">
      <header className="console-head">
        <div className="console-tabs" role="group" aria-label="Console tab">
          <button
            type="button"
            aria-pressed={open && tab === "output"}
            onClick={() => {
              setTab("output");
              setOpen(true);
            }}
          >
            Output
            {printed.length > 0 && <span className="console-badge">{printed.length}</span>}
            {failures.length > 0 && <span className="console-badge bad">{failures.length}</span>}
          </button>
          <button
            type="button"
            aria-pressed={open && tab === "runtime"}
            title={TRACE_TITLE[pipeline]}
            onClick={() => {
              setTab("runtime");
              setOpen(true);
            }}
          >
            {TRACE_LABEL[pipeline]}
            {primary.events.length > 0 && <span className="console-badge">{primary.events.length}</span>}
          </button>
        </div>
        <span className={`console-status tone-${status.tone}`} role="status" aria-live="polite">
          {status.text}
        </span>
        <button
          type="button"
          className="console-fold"
          aria-pressed={!open}
          title={open ? "Collapse the panel" : "Expand the panel"}
          onClick={() => setOpen((on) => !on)}
        >
          {open ? "▾" : "▴"}
        </button>
        <RunButton busy={busy} onRun={onRun} />
      </header>

      {open && tab === "output" && (
        <div className="console-body">
          {printed.length > 0 && (
            <pre className="console-print">
              {printed.map((line, at) => (
                <div key={at}>{line === "" ? " " : line}</div>
              ))}
            </pre>
          )}
          {primary.outputDropped > 0 && (
            <p className="console-note">+{primary.outputDropped} more lines printed, not shown.</p>
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
              the code above and see what it prints.
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

      {open && tab === "runtime" && (
        <div className="console-body">
          <RuntimeTimeline events={primary.events} dropped={primary.dropped} pipeline={pipeline} />
        </div>
      )}
    </section>
  );
}
