import { IrEditor } from "@tera/editor";
import { useCallback, useEffect, useState } from "react";
import { noteFor } from "../content/passes";
import { LAB_FIXTURES } from "../content/lab-fixtures";
import type { CompilerClient } from "../services/compiler-client";
import type { LabResult, OptLevelId } from "../types/stage";
import { DiffView } from "./DiffView";

const OPAQUE = /<opaque:([A-Za-z0-9_]+)>/g;

type IrLabProps = {
  client: CompilerClient | null;
  optLevel: OptLevelId;
  seed: string | null;
  onSeedTaken: () => void;
};

function opaqueNames(text: string): readonly string[] {
  return [...new Set([...text.matchAll(OPAQUE)].map((found) => found[1]!))];
}

export function IrLab({ client, optLevel, seed, onSeedTaken }: IrLabProps) {
  const [text, setText] = useState(LAB_FIXTURES[0]!.text);
  const [pass, setPass] = useState(LAB_FIXTURES[0]!.pass);
  const [passNames, setPassNames] = useState<readonly string[]>([]);
  const [result, setResult] = useState<LabResult | null>(null);
  const [busy, setBusy] = useState(false);

  // A result belongs to the text and pass it came from; changing either makes the
  // pane below lie, so it is dropped rather than left to look current.
  const edit = useCallback((next: string) => {
    setText(next);
    setResult(null);
  }, []);
  const choose = useCallback((next: string) => {
    setPass(next);
    setResult(null);
  }, []);

  useEffect(() => {
    if (client === null) return;
    client.passNames().then(setPassNames).catch(() => undefined);
  }, [client]);

  useEffect(() => {
    if (seed === null) return;
    setText(seed);
    setResult(null);
    onSeedTaken();
  }, [onSeedTaken, seed]);

  const run = useCallback(async () => {
    if (client === null) return;
    setBusy(true);
    try {
      setResult(await client.runPass({ text, pass, optLevel }));
    } finally {
      setBusy(false);
    }
  }, [client, optLevel, pass, text]);

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
        <div className="lab-pane">
          <h3>Input IR</h3>
          <IrEditor value={text} onChange={edit} />
        </div>
        <div className="lab-pane">
          <h3>After {pass}</h3>
          {result === null && <div className="viewer-note">Press Run pass.</div>}
          {result !== null && result.error !== null && <pre className="run-error">{result.error}</pre>}
          {result !== null && result.error === null && (
            <DiffView before={result.before} after={result.after} />
          )}
        </div>
      </div>
    </section>
  );
}
