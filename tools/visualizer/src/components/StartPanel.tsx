import { SAMPLES, type Sample } from "../content/samples";

type StartPanelProps = {
  busy: boolean;
  onPick: (sample: Sample) => void;
};

export function StartPanel({ busy, onPick }: StartPanelProps) {
  return (
    <section className="viewer start">
      <div className="start-lead">
        <h2>Watch a program go through the compiler</h2>
        <p>
          Compile the code on the left and every step the compiler takes shows up as a stage you can
          open: the tokens, the syntax tree, then each optimisation pass in turn — with a diff of what
          it rewrote and a control flow graph of the result.
        </p>
        <p className="start-nudge">
          Nothing to write? Start from one of these — each is built to make a particular pass do
          something visible.
        </p>
      </div>
      <ul className="start-samples">
        {SAMPLES.map((sample) => (
          <li key={sample.id}>
            <button type="button" disabled={busy} onClick={() => onPick(sample)}>
              <span className="start-label">{sample.label}</span>
              <span className="start-hint">{sample.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
