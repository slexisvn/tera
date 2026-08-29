import { IrEditor } from "@tera/editor";
import { useCallback, useEffect, useState } from "react";
import type { RegionId } from "../config/panes";
import { noteFor } from "../content/passes";
import { LAB_FIXTURES } from "../content/lab-fixtures";
import type { CompilerClient } from "../services/compiler-client";
import type { LabResult, LabSequence, OptLevelId } from "../types/stage";
import { DiffView } from "./DiffView";
import { RemarkList } from "./RemarkList";

const OPAQUE = /<opaque:([A-Za-z0-9_]+)>/g;

type IrLabProps = {
  client: CompilerClient | null;
  optLevel: OptLevelId;
  seed: string | null;
  hidden: (region: RegionId) => boolean;
  onSeedTaken: () => void;
};

type SequenceProps = {
  sequence: LabSequence;
  at: number;
  onPick: (at: number) => void;
};

function Sequence({ sequence, at, onPick }: SequenceProps) {
  const notable = sequence.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.changed || step.error !== null);
  const shown = sequence.steps[at] ?? null;

  return (
    <div className="lab-steps">
      <div className="lab-step-rail">
        {notable.length === 0 ? (
          <span className="lab-note">
            All {sequence.steps.length} passes ran and none of them changed this graph.
          </span>
        ) : (
          notable.map(({ step, index }) => (
            <button
              type="button"
              key={step.pass}
              className={`lab-step${step.error === null ? "" : " failed"}`}
              aria-pressed={index === at}
              onClick={() => onPick(index)}
            >
              {step.pass}
            </button>
          ))
        )}
      </div>
      {shown !== null && shown.error !== null && <pre className="run-error">{shown.error}</pre>}
      {shown !== null && shown.error === null && (
        <>
          <DiffView before={shown.before} after={shown.after} />
          {shown.remarks.length > 0 && <RemarkList remarks={shown.remarks} selectedNode={null} />}
        </>
      )}
    </div>
  );
}

function opaqueNames(text: string): readonly string[] {
  return [...new Set([...text.matchAll(OPAQUE)].map((found) => found[1]!))];
}

export function IrLab({ client, optLevel, seed, hidden, onSeedTaken }: IrLabProps) {
  const [text, setText] = useState(LAB_FIXTURES[0]!.text);
  const [pass, setPass] = useState(LAB_FIXTURES[0]!.pass);
  const [passNames, setPassNames] = useState<readonly string[]>([]);
  const [result, setResult] = useState<LabResult | null>(null);
  const [sequence, setSequence] = useState<LabSequence | null>(null);
  const [stepAt, setStepAt] = useState(0);
  const [busy, setBusy] = useState(false);

  const edit = useCallback((next: string) => {
    setText(next);
    setResult(null);
    setSequence(null);
  }, []);
  const choose = useCallback((next: string) => {
    setPass(next);
    setResult(null);
    setSequence(null);
  }, []);

  useEffect(() => {
    if (client === null) return;
    client.passNames().then(setPassNames).catch(() => undefined);
  }, [client]);

  useEffect(() => {
    if (seed === null) return;
    setText(seed);
    setResult(null);
    setSequence(null);
    onSeedTaken();
  }, [onSeedTaken, seed]);

  const run = useCallback(async () => {
    if (client === null) return;
    setBusy(true);
    try {
      setSequence(null);
      setResult(await client.runPass({ text, pass, optLevel }));
    } finally {
      setBusy(false);
    }
  }, [client, optLevel, pass, text]);

  const runAll = useCallback(async () => {
    if (client === null) return;
    setBusy(true);
    try {
      setResult(null);
      const whole = await client.runPasses({ text, optLevel });
      setSequence(whole);
      const first = whole.steps.findIndex((step) => step.changed || step.error !== null);
      setStepAt(first < 0 ? 0 : first);
    } finally {
      setBusy(false);
    }
  }, [client, optLevel, text]);

  const opaque = opaqueNames(text);
  const note = noteFor(pass);

  return (
    <section className="lab">
      <div className="lab-controls">
        <select
          value=""
          aria-label="Load a fixture"
          onChange={(event) => {
            const fixture = LAB_FIXTURES.find((item) => item.id === event.target.value);
            if (fixture) {
              setText(fixture.text);
              setPass(fixture.pass);
              setResult(null);
              setSequence(null);
            }
            event.currentTarget.value = "";
          }}
        >
          <option value="">Fixture…</option>
          {LAB_FIXTURES.map((fixture) => (
            <option key={fixture.id} value={fixture.id}>
              {fixture.label} → {fixture.pass}
            </option>
          ))}
        </select>
        <select value={pass} aria-label="Pass to run" onChange={(event) => choose(event.target.value)}>
          {passNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button type="button" onClick={run} disabled={busy || client === null}>
          {busy ? "Running…" : "Run pass"}
        </button>
        <button
          type="button"
          onClick={runAll}
          disabled={busy || client === null}
          title="Run every middle-end pass in order over this graph and step through what each one did"
        >
          Run all passes
        </button>
        {note !== null && <span className="lab-note">{note.what}</span>}
      </div>

      {opaque.length > 0 && (
        <p className="lab-warning">
          This IR holds {opaque.join(", ")} as <code>&lt;opaque:…&gt;</code>. Parsing cannot rebuild those
          values, so a pass that reads them (inlining, call-signature stamping) will not behave as it does
          on a real graph.
        </p>
      )}

      <div className="lab-panes">
        <div className="lab-pane" data-region="lab-in" data-hidden={hidden("lab-in") || undefined}>
          <h3>Input IR</h3>
          <IrEditor value={text} onChange={edit} />
        </div>
        <div className="lab-pane" data-region="lab-out" data-hidden={hidden("lab-out") || undefined}>
          <h3>{sequence === null ? `After ${pass}` : "Every pass, in order"}</h3>
          {sequence !== null && <Sequence sequence={sequence} at={stepAt} onPick={setStepAt} />}
          {sequence === null && result === null && (
            <div className="viewer-note">
              Press <strong>Run pass</strong> for the one pass above, or <strong>Run all passes</strong>{" "}
              to walk the whole middle end over this graph.
            </div>
          )}
          {sequence === null && result !== null && result.error !== null && (
            <pre className="run-error">{result.error}</pre>
          )}
          {sequence === null && result !== null && result.error === null && (
            <>
              <DiffView before={result.before} after={result.after} />
              {result.remarks.length > 0 && (
                <RemarkList remarks={result.remarks} selectedNode={null} />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
