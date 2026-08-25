import { useTeraAnalysis, type TeraEditorHandle } from "@tera/editor";
import { useMediaQuery, useTheme } from "@tera/ui";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { ActionBar } from "../components/ActionBar";
import type { Badges } from "../components/Badge";
import { IrLab } from "../components/IrLab";
import { PaneTabs } from "../components/PaneTabs";
import { PipelineRail } from "../components/PipelineRail";
import { Region } from "../components/Region";
import { RunConsole } from "../components/RunConsole";
import { SetupControls } from "../components/SetupControls";
import { SourcePane } from "../components/SourcePane";
import { Splitter } from "../components/Splitter";
import { StageViewer } from "../components/StageViewer";
import { StartPanel } from "../components/StartPanel";
import {
  BUSY_DELAY_MS,
  COMPACT_QUERY,
  DOCUMENT_ID,
  SOURCE_KEY,
  SPLIT_QUERY,
  THEME_KEY,
} from "../config/constants";
import {
  FAILURE_TAB,
  MODES,
  stackedRegions,
  tabsFor,
  type ConsoleTab,
  type Density,
  type Mode,
  type PaneTab,
  type RegionId,
  type TabId,
} from "../config/panes";
import { SAMPLES, type Sample } from "../content/samples";
import { CompilerClient } from "../services/compiler-client";
import { errorLineOf, failuresOf, statusOf } from "../services/run-report";
import type { OptLevelId, RunResult, Stage, TargetInfo } from "../types/stage";

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
const SEPARATOR = "\u0000";

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
  const [compiled, setCompiled] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hideUnchanged, setHideUnchanged] = useState(true);
  const [labSeed, setLabSeed] = useState<string | null>(null);
  const [pane, setPane] = useState<TabId>("source");
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>("output");
  const [setupOpen, setSetupOpen] = useState(false);
  const [codeSize, setCodeSize] = useState<number | null>(null);
  const [railSize, setRailSize] = useState<number | null>(null);
  const [consoleSize, setConsoleSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [client, setClient] = useState<CompilerClient | null>(null);
  const clientRef = useRef<CompilerClient | null>(null);
  const running = useRef(false);
  const editor = useRef<TeraEditorHandle>(null);
  const setupId = useId();

  const compact = useMediaQuery(COMPACT_QUERY);
  const split = useMediaQuery(SPLIT_QUERY);
  const density: Density = compact ? "compact" : split ? "split" : "wide";

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

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const handle = window.setTimeout(() => setSlow(true), BUSY_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [busy]);

  const pipelineOf = useCallback(
    (id: string) => targets.find((target) => target.id === id)?.pipeline ?? "jit",
    [targets],
  );

  const pipeline = pipelineOf(targetId);
  const request = [mode, optLevel, targetId, source].join(SEPARATOR);
  const hasRun = compiled !== null;

  const tabs = useMemo(() => tabsFor(mode, density), [density, mode]);
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === pane) ?? tabs[0] ?? null, [pane, tabs]);
  const stacked = useMemo(() => stackedRegions(density), [density]);
  const hidden = useCallback(
    (region: RegionId) => stacked.has(region) && region !== activeTab?.region,
    [activeTab, stacked],
  );

  const showRunBar = tabs.every((tab) => tab.region !== "source") || activeTab?.region === "source";

  const pickTab = useCallback((tab: PaneTab) => {
    setPane(tab.id);
    if (tab.consoleTab !== undefined) setConsoleTab(tab.consoleTab);
  }, []);

  const openMode = useCallback(
    (next: Mode) => {
      const entry = MODES.find((mode) => mode.id === next)!;
      setMode(next);
      setPane(entry.landing !== undefined && !hasRun ? "source" : entry.home);
    },
    [hasRun],
  );

  const land = useCallback(
    (failed: boolean) => {
      const home = MODES.find((entry) => entry.id === mode)?.landing;
      const reports = tabsFor(mode, "compact").some((tab) => tab.id === FAILURE_TAB);
      const landing = failed && reports ? FAILURE_TAB : home;
      if (landing === undefined) return;
      if (landing === FAILURE_TAB) setConsoleTab("output");
      setPane((current) => (current === "source" ? landing : current));
    },
    [mode],
  );

  const run = useCallback(async () => {
    const worker = clientRef.current;
    if (worker === null || running.current) return;
    const text = source;
    const signature = request;
    if (text.trim() === "") {
      setResult({ ...EMPTY, error: "There is no code to compile yet — write something, or pick a sample." });
      setCompiled(signature);
      setSelectedId(null);
      land(true);
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      const next = await worker.run({
        source: text,
        pipeline: pipelineOf(targetId),
        optLevel,
        target: targetId,
      });
      setResult(next);
      setCompiled(signature);
      setSelectedId((current) => landingStage(next.stages, current));
      setSelectedNode(null);
      setHoveredNode(null);
      land(next.error !== null || next.runError !== null);
    } catch (error) {
      setResult({ ...EMPTY, error: error instanceof Error ? error.message : String(error) });
      setCompiled(signature);
      land(true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [land, optLevel, pipelineOf, request, source, targetId]);

  const loadSample = useCallback((sample: Sample) => {
    setSource(sample.source);
    setPane("source");
    setSetupOpen(false);
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
    openMode("lab");
  }, [openMode, selected]);

  const goToLine = useCallback((line: number) => editor.current?.goToLine(line), []);

  const stale = hasRun && compiled !== request;

  const failures = useMemo(() => failuresOf(result), [result]);

  const status = useMemo(
    () => statusOf({ result, busy: slow, hasRun, stale }),
    [hasRun, result, slow, stale],
  );

  const badges = useMemo<Badges>(
    () => ({
      output:
        failures.length > 0
          ? { count: failures.length, tone: "bad" }
          : { count: result.output.length, tone: "info" },
      runtime: { count: result.events.length, tone: "info" },
    }),
    [failures.length, result.events.length, result.output.length],
  );

  const workspaceStyle = useMemo(() => {
    const sized: Record<string, string> = {};
    if (codeSize !== null) sized["--code-w"] = `${codeSize}px`;
    if (railSize !== null) sized["--rail-w"] = `${railSize}px`;
    if (consoleSize !== null) sized["--console-h"] = `${consoleSize}px`;
    return sized as CSSProperties;
  }, [codeSize, consoleSize, railSize]);

  const setup = (
    <SetupControls
      mode={mode}
      targets={targets}
      targetId={targetId}
      optLevel={optLevel}
      theme={theme}
      onSample={loadSample}
      onTarget={setTargetId}
      onOptLevel={setOptLevel}
      onToggleTheme={toggleTheme}
    />
  );

  const setupToggle = (
    <button
      type="button"
      className="setup-toggle"
      aria-expanded={setupOpen}
      aria-controls={setupId}
      title="Sample program, compile target and optimisation level"
      onClick={() => setSetupOpen((on) => !on)}
    >
      Setup
    </button>
  );

  const setupSheet = setupOpen ? (
    <div className="actions setup" id={setupId}>
      {setup}
    </div>
  ) : null;

  return (
    <>
      <header className="toolbar">
        <div className="brand">
          <h1 className="logo">Tera</h1>
          <span className="sub">compiler visualizer</span>
        </div>
        <div className="mode-switch" role="group" aria-label="Mode">
          {MODES.map((entry) => (
            <button
              type="button"
              key={entry.id}
              data-label={entry.label}
              title={entry.title}
              aria-pressed={mode === entry.id}
              onClick={() => openMode(entry.id)}
            >
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
        <div className="actions">{density === "wide" ? setup : setupToggle}</div>
        {density !== "wide" && setupSheet}
      </header>

      <div className="workspace" data-mode={mode} data-density={density} style={workspaceStyle}>
        {tabs.length > 1 && (
          <PaneTabs
            tabs={tabs}
            active={activeTab?.id ?? null}
            pipeline={pipeline}
            badges={badges}
            onPick={pickTab}
          />
        )}

        {mode === "lab" ? (
          <Region id="lab" hidden={false}>
            <IrLab
              client={client}
              optLevel={optLevel}
              seed={labSeed}
              hidden={hidden}
              onSeedTaken={takeLabSeed}
            />
          </Region>
        ) : (
          <>
            <Region id="source" hidden={hidden("source")}>
              <SourcePane
                source={source}
                handle={editor}
                documentId={DOCUMENT_ID}
                analysis={analysis}
                diagnostics={diagnosticsFor(DOCUMENT_ID)}
                highlightedLine={highlightedLine}
                onChange={setSource}
              />
            </Region>

            {mode === "pipeline" && (
              <>
                <Region id="stages" hidden={hidden("stages")}>
                  <PipelineRail
                    stages={result.stages}
                    selectedId={selectedId}
                    hideUnchanged={hideUnchanged}
                    hasRun={hasRun}
                    onSelect={showStage}
                    onToggleUnchanged={() => setHideUnchanged((on) => !on)}
                  />
                </Region>

                <Region id="detail" hidden={hidden("detail")}>
                  {stale && hasRun && (
                    <button type="button" className="stale-banner" onClick={() => void run()} disabled={busy}>
                      These stages are from the previous compile — the code or the settings changed
                      since. <strong>Compile &amp; run again</strong>
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
                </Region>
              </>
            )}

            <Region id="console" hidden={hidden("console")}>
              <RunConsole
                result={result}
                failures={failures}
                badges={badges}
                status={status}
                pipeline={pipeline}
                busy={slow}
                ready={client !== null}
                hasRun={hasRun}
                docked={!compact}
                tab={consoleTab}
                onTab={setConsoleTab}
                onRun={() => void run()}
                onGoToLine={goToLine}
              />
            </Region>

            {compact && showRunBar && (
              <ActionBar status={status} busy={slow} ready={client !== null} onRun={() => void run()} />
            )}

            {!compact && (
              <>
                <Splitter
                  axis="x"
                  area="vcode"
                  region="source"
                  dir={1}
                  min={220}
                  maxRatio={0.6}
                  label="width of the code pane"
                  onResize={setCodeSize}
                />
                <Splitter
                  axis="y"
                  area="hcode"
                  region="console"
                  dir={-1}
                  min={72}
                  maxRatio={0.8}
                  label="height of the run console under the editor"
                  onResize={setConsoleSize}
                />
                {density === "wide" && mode === "pipeline" && (
                  <Splitter
                    axis="x"
                    area="vrail"
                    region="stages"
                    dir={1}
                    min={180}
                    maxRatio={0.4}
                    label="width of the pass list"
                    onResize={setRailSize}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
