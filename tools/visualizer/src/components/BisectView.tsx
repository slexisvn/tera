import type { BisectResult, PipelineId } from "../types/stage";

type BisectViewProps = {
  result: BisectResult | null;
  busy: boolean;
  ready: boolean;
  stale: boolean;
  pipeline: PipelineId;
  canOpen: boolean;
  onRun: () => void;
  onOpen: () => void;
};

const HEADLINE: Readonly<Record<BisectResult["verdict"], string>> = {
  found: "First pass whose work changes the answer",
  clean: "No optional pass changes the answer",
  "before-passes": "The answer was already wrong with every optional pass off",
  "no-passes": "Nothing to bisect",
  failed: "The search could not finish",
};

function Sides({ result, pipeline }: { result: BisectResult; pipeline: PipelineId }) {
  const left = pipeline === "aot" ? "with no optional pass" : "interpreter, no JIT";
  const right = result.verdict === "found" ? `up to pass #${result.limit}` : "with every pass";
  return (
    <div className="bisect-sides">
      <section>
        <h4>{left}</h4>
        <pre>{result.reference.join("\n") || "(printed nothing)"}</pre>
      </section>
      <section>
        <h4>{right}</h4>
        <pre>{result.observed.join("\n") || "(printed nothing)"}</pre>
      </section>
    </div>
  );
}

function Explain({ result, pipeline }: { result: BisectResult; pipeline: PipelineId }) {
  if (result.verdict === "found") {
    return (
      <p className="bisect-lead">
        Running the first <strong>{result.limit}</strong> of {result.total} optional passes already
        changes {result.oracle}; running {result.limit - 1} does not.
      </p>
    );
  }
  if (result.verdict === "clean") {
    return (
      <p className="bisect-lead">
        All {result.total} optional passes together leave {result.oracle} exactly as it is without
        them. Whatever you are chasing is not one of them.
      </p>
    );
  }
  if (result.verdict === "before-passes") {
    return (
      <p className="bisect-lead">
        {pipeline === "aot"
          ? "The build is already broken with every optional pass turned off, so no optimization pass is responsible — look at module lowering, machine IR or the backend."
          : "With every optional pass turned off the JIT still disagrees with the interpreter, so no optimization pass is responsible — look at the IR builder, the deopt path or the wasm backend."}
      </p>
    );
  }
  if (result.verdict === "no-passes") {
    return (
      <p className="bisect-lead">
        No optional pass ran at all. Every function here was turned down by the optimizer and stays
        with the interpreter, so there is no pass to blame — read the Passes rail for the reason each
        one was declined.
      </p>
    );
  }
  return <p className="bisect-lead bad">{result.error}</p>;
}

export function BisectView({
  result,
  busy,
  ready,
  stale,
  pipeline,
  canOpen,
  onRun,
  onOpen,
}: BisectViewProps) {
  return (
    <div className="bisect">
      <div className="bisect-bar">
        <button type="button" className="bisect-run" disabled={!ready || busy} onClick={onRun}>
          {busy ? "Searching…" : "Find the first bad pass"}
        </button>
        <span className="bisect-hint">
          Compiles the same program again and again with a growing prefix of the optimization
          passes, and reports the first one that changes{" "}
          {pipeline === "aot" ? "whether the build succeeds" : "what the program prints"}.
        </span>
      </div>

      {result === null && !busy && (
        <p className="console-note">
          Nothing searched yet. This is the fastest way to turn “the compiler gives the wrong
          answer” into the name of one pass.
        </p>
      )}

      {result !== null && (
        <div className={`bisect-result verdict-${result.verdict}`} data-stale={stale || undefined}>
          {stale && (
            <p className="result-stale">
              The code changed since this search — run it again before trusting it.
            </p>
          )}
          <h3>{HEADLINE[result.verdict]}</h3>
          {result.verdict === "found" && (
            <p className="bisect-culprit">
              <span className="bisect-number">#{result.limit}</span>
              <strong>{result.pass ?? "unknown pass"}</strong>
              {result.owner !== null && <span className="bisect-owner">on {result.owner}</span>}
              {canOpen && (
                <button type="button" className="bisect-open" onClick={onOpen}>
                  Open that stage
                </button>
              )}
            </p>
          )}
          <Explain result={result} pipeline={pipeline} />
          {result.verdict !== "no-passes" && result.verdict !== "failed" && (
            <Sides result={result} pipeline={pipeline} />
          )}
          <p className="bisect-cost">
            {result.compiles} compiles · {result.elapsedMs.toFixed(0)}ms · {result.total} optional
            passes in play
          </p>
        </div>
      )}
    </div>
  );
}
