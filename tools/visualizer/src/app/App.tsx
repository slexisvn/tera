import { TeraEditor, useTeraAnalysis, type TeraEditorHandle } from "@tera/editor";
import { useTheme } from "@tera/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompareView } from "../components/CompareView";
import { IrLab } from "../components/IrLab";
import { PipelineRail } from "../components/PipelineRail";
import { RuntimeTimeline } from "../components/RuntimeTimeline";
import { StageViewer } from "../components/StageViewer";
import { StartPanel } from "../components/StartPanel";
import { SAMPLES, type Sample } from "../content/samples";
import { DOCUMENT_ID, SOURCE_KEY, THEME_KEY } from "../config/constants";
import { CompilerClient } from "../services/compiler-client";
import type { OptLevelId, RunResult, Stage, TargetInfo } from "../types/stage";

type Mode = "pipeline" | "lab" | "compare";
type Pane = "source" | "stages" | "detail";

const PANES: readonly { id: Pane; label: string }[] = [
  { id: "source", label: "Source" },
  { id: "stages", label: "Stages" },
  { id: "detail", label: "Viewer" },
];

const MODES: readonly { id: Mode; label: string }[] = [
  { id: "pipeline", label: "Pipeline" },
  { id: "lab", label: "IR lab" },
  { id: "compare", label: "Compare" },
];

const OPT_LEVELS: readonly OptLevelId[] = ["none", "baseline", "speed", "max"];
const EMPTY: RunResult = { stages: [], events: [], dropped: {}, error: null, elapsedMs: 0 };

const ERROR_POSITION = /\bat (\d+):(\d+)\b/;

function errorLineOf(message: string | null): number | null {
  if (message === null) return null;
  const found = ERROR_POSITION.exec(message);
  return found === null ? null : Number(found[1]);
}

function landingStage(stages: readonly Stage[], keep: string | null): string | null {
  if (keep !== null && stages.some((stage) => stage.id === keep)) return keep;
  const failure = stages.find((stage) => stage.failed);
  if (failure !== undefined) return failure.id;
  return (
    stages.find((stage) => stage.kind === "ir" && stage.changed)?.id ??
    stages.find((stage) => stage.kind === "ir")?.id ??
    stages.find((stage) => stage.changed)?.id ??
    stages[0]?.id ??
    null
  );
}

function initialSource(): string {
  return localStorage.getItem(SOURCE_KEY) ?? SAMPLES[0]!.source;
}

export default function App() {
  const [source, setSource] = useState(initialSource);
  const [theme, toggleTheme] = useTheme(THEME_KEY);
  const [targets, setTargets] = useState<readonly TargetInfo[]>([]);
  const [targetId, setTargetId] = useState("wasm");
  const [optLevel, setOptLevel] = useState<OptLevelId>("speed");
  const [mode, setMode] = useState<Mode>("pipeline");
  const [result, setResult] = useState<RunResult>(EMPTY);
  const [rival, setRival] = useState<RunResult>(EMPTY);
  const [compiledSource, setCompiledSource] = useState<string | null>(null);
  const [sampleHint, setSampleHint] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hideUnchanged, setHideUnchanged] = useState(true);
  const [showTimeline, setShowTimeline] = useState(false);
  const [labSeed, setLabSeed] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("source");
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState<CompilerClient | null>(null);
  const clientRef = useRef<CompilerClient | null>(null);
  const editor = useRef<TeraEditorHandle>(null);

  const documents = useMemo(() => [{ id: DOCUMENT_ID, source }], [source]);
  const { analysis, diagnosticsFor } = useTeraAnalysis(documents);

  useEffect(() => {
    const started = new CompilerClient();
    clientRef.current = started;
    setClient(started);
    started.targets().then(setTargets).catch(() => undefined);
    return () => {
      started.terminate();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => localStorage.setItem(SOURCE_KEY, source), 300);
    return () => window.clearTimeout(handle);
  }, [source]);

  const pipelineOf = useCallback(
    (id: string) => targets.find((target) => target.id === id)?.pipeline ?? "jit",
    [targets],
  );

  const aotTargetId = useMemo(() => {
    if (pipelineOf(targetId) === "aot") return targetId;
    return targets.find((target) => target.pipeline === "aot")?.id ?? "c";
  }, [pipelineOf, targetId, targets]);

  const run = useCallback(
    async (override?: string) => {
      const worker = clientRef.current;
      if (worker === null) return;
      const text = override ?? source;
      if (text.trim() === "") {
        setResult({ ...EMPTY, error: "There is no code to compile yet — write something, or pick a sample." });
        setCompiledSource(text);
        setSelectedId(null);
        return;
      }
      setBusy(true);
      try {
        if (mode === "compare") {
          const [jit, aot] = await Promise.all([
            worker.run({ source: text, pipeline: "jit", optLevel, target: "wasm" }),
            worker.run({ source: text, pipeline: "aot", optLevel, target: aotTargetId }),
          ]);
          setResult(jit);
          setRival(aot);
          setCompiledSource(text);
          setSelectedId((current) => landingStage(jit.stages, current));
          return;
        }
        const next = await worker.run({
          source: text,
          pipeline: pipelineOf(targetId),
          optLevel,
          target: targetId,
        });
        setResult(next);
        setCompiledSource(text);
        setSelectedId((current) => landingStage(next.stages, current));
        setSelectedNode(null);
        setHoveredNode(null);
        setPane("stages");
      } catch (error) {
        setResult({ ...EMPTY, error: error instanceof Error ? error.message : String(error) });
        setCompiledSource(text);
      } finally {
        setBusy(false);
      }
    },
    [aotTargetId, mode, optLevel, pipelineOf, source, targetId],
  );

  const loadSample = useCallback(
    (sample: Sample) => {
      setSource(sample.source);
      setSampleHint(sample.hint);
      void run(sample.source);
    },
    [run],
  );

  const edit = useCallback((next: string) => {
    setSource(next);
    setSampleHint(null);
  }, []);

  const visible = useMemo(
    () => (hideUnchanged ? result.stages.filter((stage) => stage.changed) : result.stages),
    [hideUnchanged, result.stages],
  );

  const step = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const at = visible.findIndex((stage) => stage.id === selectedId);
      const next = Math.min(visible.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta));
      setSelectedId(visible[next]!.id);
    },
    [selectedId, visible],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (mode !== "pipeline") return;
      if (event.altKey && (event.code === "KeyJ" || event.code === "KeyK")) {
        event.preventDefault();
        step(event.code === "KeyJ" ? 1 : -1);
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.key === "j") step(1);
      else if (event.key === "k") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, step]);

  const selected = result.stages.find((stage) => stage.id === selectedId) ?? null;
  const linkedNode = hoveredNode ?? selectedNode;
  const failureLine = errorLineOf(result.error);
  const highlightedLine =
    selected === null || linkedNode === null
      ? failureLine
      : (selected.positions[linkedNode] ?? failureLine);
  const previous = useMemo(() => {
    if (selected === null || (selected.kind !== "ir" && selected.kind !== "machine")) return null;
    for (let at = result.stages.indexOf(selected) - 1; at >= 0; at--) {
      const candidate = result.stages[at]!;
      if (candidate.kind === selected.kind && candidate.owner === selected.owner) return candidate;
    }
    return null;
  }, [result.stages, selected]);

  const takeLabSeed = useCallback(() => setLabSeed(null), []);

  const showStage = useCallback((id: string) => {
    setSelectedId(id);
    setPane("detail");
  }, []);

  const sendToLab = useCallback(() => {
    if (selected === null || selected.kind !== "ir") return;
    setLabSeed(selected.text);
    setMode("lab");
  }, [selected]);

  const hasRun = compiledSource !== null;
  const stale = hasRun && compiledSource !== source;
  const status =
    mode === "lab"
      ? null
      : busy
        ? "Compiling…"
        : !hasRun
          ? null
          : result.error !== null
            ? "compile failed"
            : `${result.stages.length} stages · ${result.elapsedMs.toFixed(0)}ms`;

  const errors = useMemo(
    () => [...new Set([result.error, mode === "compare" ? rival.error : null])].filter(
      (message): message is string => message !== null,
    ),
    [mode, result.error, rival.error],
  );

  const errorBanner = errors.map((message) => {
    const line = errorLineOf(message);
    return line === null ? (
      <pre className="run-error" key={message}>
        {message}
      </pre>
    ) : (
      <button
        type="button"
        className="run-error"
        key={message}
        onClick={() => editor.current?.goToLine(line)}
      >
        {message}
        <span className="run-error-go">go to line {line}</span>
      </button>
    );
  });

  return (
    <>
      <header className="toolbar">
        <div className="brand">
          <h1 className="logo">Tera</h1>
          <span className="sub">compiler visualizer</span>
        </div>
        <div className="actions">
          <div className="mode-switch" role="group" aria-label="Mode">
            {MODES.map((entry) => (
              <button
                type="button"
                key={entry.id}
                aria-pressed={mode === entry.id}
                onClick={() => setMode(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {mode !== "lab" && (
            <select
              value=""
              aria-label="Load a sample"
              onChange={(event) => {
                const sample = SAMPLES.find((item) => item.id === event.target.value);
                if (sample) loadSample(sample);
                event.currentTarget.value = "";
              }}
            >
              <option value="">Sample…</option>
              {SAMPLES.map((sample) => (
                <option key={sample.id} value={sample.id}>
                  {sample.label}
                </option>
              ))}
            </select>
          )}
          {mode !== "lab" && (
            <select value={targetId} aria-label="Target" onChange={(event) => setTargetId(event.target.value)}>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </select>
          )}
          <select
            value={optLevel}
            aria-label="Optimization level"
            onChange={(event) => setOptLevel(event.target.value as OptLevelId)}
          >
            {OPT_LEVELS.map((level) => (
              <option key={level} value={level}>
                -O {level}
              </option>
            ))}
          </select>
          {mode !== "lab" && (
            <button
              type="button"
              className={stale || !hasRun ? "primary" : ""}
              onClick={() => run()}
              disabled={busy}
            >
              {busy ? "Compiling…" : "Compile"}
            </button>
          )}
          {mode === "pipeline" && (
            <>
              <button
                type="button"
                className="desk-only"
                onClick={sendToLab}
                disabled={selected === null || selected.kind !== "ir"}
                title={
                  selected === null || selected.kind !== "ir"
                    ? "Open an IR stage to send its graph to the lab"
                    : "Edit this graph by hand in the IR lab"
                }
              >
                Send to lab
              </button>
              <button
                type="button"
                className="desk-only"
                aria-pressed={showTimeline}
                onClick={() => setShowTimeline((on) => !on)}
              >
                Runtime
              </button>
            </>
          )}
          <button type="button" onClick={toggleTheme}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <span className={`status${busy ? " busy" : ""}`} role="status" aria-live="polite">
            {status}
          </span>
        </div>
      </header>

      {mode === "lab" && (
        <div className="layout lab-layout">
          <IrLab client={client} optLevel={optLevel} seed={labSeed} onSeedTaken={takeLabSeed} />
        </div>
      )}

      {mode === "compare" && (
        <div className="layout compare-layout">
          <aside className="source-pane">
            <TeraEditor
              value={source}
              handle={editor}
              documentId={DOCUMENT_ID}
              analysis={analysis}
              diagnostics={diagnosticsFor(DOCUMENT_ID)}
              highlightedLine={highlightedLine}
              onChange={edit}
            />
            {errorBanner}
          </aside>
          <CompareView
            left={result}
            right={rival}
            leftLabel="JIT · wasm"
            rightLabel={`AOT · ${aotTargetId}`}
            hasRun={hasRun}
            failed={errors.length > 0}
          />
        </div>
      )}

      {mode === "pipeline" && (
        <div className="layout" data-pane={pane}>
          <nav className="pane-switch" aria-label="Pane">
            {PANES.map((entry) => (
              <button
                type="button"
                key={entry.id}
                aria-pressed={pane === entry.id}
                onClick={() => setPane(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <aside className="source-pane">
            <TeraEditor
              value={source}
              handle={editor}
              documentId={DOCUMENT_ID}
              analysis={analysis}
              diagnostics={diagnosticsFor(DOCUMENT_ID)}
              highlightedLine={highlightedLine}
              onChange={edit}
            />
            {errorBanner}
            {sampleHint !== null && <p className="source-hint">{sampleHint}</p>}
          </aside>

          <PipelineRail
            stages={result.stages}
            selectedId={selectedId}
            hideUnchanged={hideUnchanged}
            hasRun={hasRun}
            onSelect={showStage}
            onToggleUnchanged={() => setHideUnchanged((on) => !on)}
          />

          <div className="detail">
            {stale && (
              <button type="button" className="stale-banner" onClick={() => run()} disabled={busy}>
                Source changed — these stages are from the previous version.{" "}
                <strong>Compile again</strong>
              </button>
            )}
            {hasRun ? (
              <StageViewer
                stage={selected}
                previous={previous}
                selectedNode={selectedNode}
                onSelectNode={setSelectedNode}
                onHoverNode={setHoveredNode}
              />
            ) : (
              <StartPanel busy={busy} onPick={loadSample} />
            )}
            {showTimeline && <RuntimeTimeline events={result.events} dropped={result.dropped} />}
          </div>
        </div>
      )}
    </>
  );
}
