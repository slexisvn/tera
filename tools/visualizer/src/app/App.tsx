import { useTeraAnalysis, type TeraEditorHandle } from "@tera/editor";
import { useTheme } from "@tera/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompareView } from "../components/CompareView";
import { IrLab } from "../components/IrLab";
import { PipelineRail } from "../components/PipelineRail";
import { RunButton } from "../components/RunButton";
import { SourcePane } from "../components/SourcePane";
import { StageViewer } from "../components/StageViewer";
import { StartPanel } from "../components/StartPanel";
import type { ConsoleRun } from "../components/RunConsole";
import { SAMPLES, type Sample } from "../content/samples";
import { DOCUMENT_ID, SOURCE_KEY, THEME_KEY } from "../config/constants";
import { CompilerClient } from "../services/compiler-client";
import { errorLineOf } from "../services/run-report";
import type { OptLevelId, RunResult, Stage, TargetInfo } from "../types/stage";

type Mode = "pipeline" | "lab" | "compare";
type Pane = "source" | "stages" | "detail";

const PANES: readonly { id: Pane; label: string }[] = [
  { id: "source", label: "Code" },
  { id: "stages", label: "Passes" },
  { id: "detail", label: "Viewer" },
];

const MODES: readonly { id: Mode; label: string; title: string }[] = [
  {
    id: "pipeline",
    label: "Pipeline",
    title: "Compile one program and step through every stage the compiler goes through",
  },
  {
    id: "lab",
    label: "IR lab",
    title: "Hand-write an SSA graph and run a single pass over it",
  },
  {
    id: "compare",
    label: "JIT vs AOT",
    title: "Compile the same program down both pipelines and line the passes up side by side",
  },
];

const OPT_LEVELS: readonly { id: OptLevelId; label: string }[] = [
  { id: "none", label: "-O none · no passes" },
  { id: "baseline", label: "-O baseline" },
  { id: "speed", label: "-O speed" },
  { id: "max", label: "-O max" },
];

const EMPTY: RunResult = {
  stages: [],
  events: [],
  dropped: {},
  output: [],
  outputDropped: 0,
  error: null,
  runError: null,
  elapsedMs: 0,
};

const JIT_LABEL = "JIT · wasm";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hideUnchanged, setHideUnchanged] = useState(true);
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

  const aotTargets = useMemo(() => targets.filter((target) => target.pipeline === "aot"), [targets]);

  const aotTargetId = useMemo(() => {
    if (pipelineOf(targetId) === "aot") return targetId;
    return aotTargets[0]?.id ?? "c";
  }, [aotTargets, pipelineOf, targetId]);

  const pipeline = mode === "compare" ? "jit" : pipelineOf(targetId);

  const run = useCallback(
    async () => {
      const worker = clientRef.current;
      if (worker === null) return;
      const text = source;
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
        setPane((current) => (current === "source" ? "stages" : current));
      } catch (error) {
        setResult({ ...EMPTY, error: error instanceof Error ? error.message : String(error) });
        setCompiledSource(text);
      } finally {
        setBusy(false);
      }
    },
    [aotTargetId, mode, optLevel, pipelineOf, source, targetId],
  );

  const loadSample = useCallback((sample: Sample) => {
    setSource(sample.source);
    setPane("source");
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
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (mode !== "lab") void run();
        return;
      }
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
  }, [mode, run, step]);

  const selected = result.stages.find((stage) => stage.id === selectedId) ?? null;
  const linkedNode = hoveredNode ?? selectedNode;
  const failureLine = errorLineOf(result.error ?? result.runError);
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

  const goToLine = useCallback((line: number) => editor.current?.goToLine(line), []);

  const hasRun = compiledSource !== null;
  const stale = hasRun && compiledSource !== source;

  const runs = useMemo<readonly ConsoleRun[]>(
    () =>
      mode === "compare"
        ? [
            { label: JIT_LABEL, result },
            { label: targets.find((target) => target.id === aotTargetId)?.label ?? "AOT", result: rival },
          ]
        : [{ label: null, result }],
    [aotTargetId, mode, result, rival, targets],
  );

  const sourcePane = (
    <SourcePane
      source={source}
      handle={editor}
      documentId={DOCUMENT_ID}
      analysis={analysis}
      diagnostics={diagnosticsFor(DOCUMENT_ID)}
      highlightedLine={highlightedLine}
      onChange={setSource}
      console={{
        runs,
        pipeline,
        busy,
        hasRun,
        stale,
        onRun: () => void run(),
        onGoToLine: goToLine,
      }}
    />
  );

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
                title={entry.title}
                aria-pressed={mode === entry.id}
                onClick={() => setMode(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {mode !== "lab" && (
            <label className="field">
              <span>Sample</span>
              <select
                value=""
                onChange={(event) => {
                  const sample = SAMPLES.find((item) => item.id === event.target.value);
                  if (sample) loadSample(sample);
                  event.currentTarget.value = "";
                }}
              >
                <option value="">load…</option>
                {SAMPLES.map((sample) => (
                  <option key={sample.id} value={sample.id}>
                    {sample.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === "pipeline" && (
            <label className="field">
              <span>Compile for</span>
              <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Passes</span>
            <select value={optLevel} onChange={(event) => setOptLevel(event.target.value as OptLevelId)}>
              {OPT_LEVELS.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="theme-toggle" onClick={toggleTheme}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>

      {mode === "lab" && (
        <div className="layout">
          <IrLab client={client} optLevel={optLevel} seed={labSeed} onSeedTaken={takeLabSeed} />
        </div>
      )}

      {mode === "compare" && (
        <div className="layout compare-layout">
          {sourcePane}
          <CompareView
            left={result}
            right={rival}
            leftLabel={JIT_LABEL}
            rightLabel={targets.find((target) => target.id === aotTargetId)?.label ?? "AOT"}
            rightTargets={aotTargets}
            rightTargetId={aotTargetId}
            onPickRightTarget={setTargetId}
            hasRun={hasRun}
            failed={result.error !== null || rival.error !== null}
          />
        </div>
      )}

      {mode === "pipeline" && (
        <div className="layout pipeline-layout" data-pane={pane}>
          <nav className="pane-switch" aria-label="Pane">
            {PANES.map((entry) => (
              <button
                type="button"
                key={entry.id}
                data-pane={entry.id}
                aria-pressed={pane === entry.id}
                onClick={() => setPane(entry.id)}
              >
                {entry.label}
              </button>
            ))}
            <RunButton busy={busy} onRun={() => void run()} className="pane-run" />
          </nav>
          {sourcePane}

          <PipelineRail
            stages={result.stages}
            selectedId={selectedId}
            hideUnchanged={hideUnchanged}
            hasRun={hasRun}
            onSelect={showStage}
            onToggleUnchanged={() => setHideUnchanged((on) => !on)}
          />

          <div className="detail">
            {stale && hasRun && (
              <button type="button" className="stale-banner" onClick={() => void run()} disabled={busy}>
                These stages are from the previous version of the code.{" "}
                <strong>Compile &amp; run again</strong>
              </button>
            )}
            {hasRun ? (
              <StageViewer
                stage={selected}
                previous={previous}
                selectedNode={selectedNode}
                onSelectNode={setSelectedNode}
                onHoverNode={setHoveredNode}
                onSendToLab={sendToLab}
              />
            ) : (
              <StartPanel busy={busy} onPick={loadSample} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
