import { createReactiveCheckOptions, createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import {
  compilerOptions,
  createBackendRegistry,
  diagnoseSource,
  Engine,
  IR_BUILDER_STAGE,
  isAotBackend,
  middleEndPassNames,
  nativeToTagged,
  parse,
  printAst,
  printIR,
  printMachineFunction,
  printModuleIR,
  runNamedPass,
  taggedToNative,
  tokenize,
  type CFGFunction,
  type CompilerOptions,
  type MachineTraceRecord,
  type ModuleTraceRecord,
  type AllocationReport,
  type PassTraceRecord,
  type Remark,
  type Token,
} from "tera";
import {
  NO_ANALYSES,
  NO_POSITIONS,
  NO_REMARKS,
  type DeoptOrigin,
  type ShapeEdge,
  type LabRequest,
  type LabResult,
  type RunRequest,
  type RunResult,
  type RuntimeEvent,
  type Stage,
  type StageRemark,
  type VisualizerPassName,
  type StageGroup,
  type TargetInfo,
} from "../types/stage";

type CompiledFn = ReturnType<Engine["collectFunctions"]>[number];

type WorkerRequest = {
  readonly id: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
};

const HOT_TIERING = { jitThreshold: 2, baselineThreshold: 1, loopOsrThreshold: 2 };
const TRACED_CATEGORIES = ["jit", "deopt", "ic", "feedback", "hidden_class", "gc", "wasm"];

const EVENT_BUDGET: Readonly<Record<string, number>> = {
  jit: 200,
  deopt: 200,
  feedback: 120,
  hidden_class: 120,
  gc: 120,
  ic: 150,
};
const DEFAULT_EVENT_BUDGET = 80;
const OUTPUT_BUDGET = 400;
const SHAPE_BUDGET = 300;
const MODULE_OWNER = "<module>";
const EXECUTED_PASS = "executed-graph" satisfies VisualizerPassName;

type ExecutedGraph = {
  ordinal: number;
  pass: string;
  text: string;
  positions: Record<string, number>;
  frozen: boolean;
};

type Outcome = {
  readonly error: string | null;
  readonly runError: string | null;
};

class OutputSink {
  readonly lines: string[] = [];
  dropped = 0;

  write = (text: string): void => {
    if (this.lines.length >= OUTPUT_BUDGET) this.dropped++;
    else this.lines.push(String(text));
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = event.data;
  try {
    let result: unknown;
    if (type === "run") result = run(payload as unknown as RunRequest);
    else if (type === "targets") result = targets();
    else if (type === "passNames") result = [...middleEndPassNames()];
    else if (type === "runPass") result = runPass(payload as unknown as LabRequest);
    else throw new Error(`Unknown request '${type}'`);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: messageOf(error) });
  }
};

function runPass(request: LabRequest): LabResult {
  const options = compilerOptions(request.optLevel);
  try {
    const outcome = runNamedPass(request.text, request.pass, options);
    return {
      before: request.text,
      after: outcome.text,
      remarks: outcome.remarks.map(stageRemark),
      error: null,
    };
  } catch (error) {
    return {
      before: request.text,
      after: request.text,
      remarks: NO_REMARKS,
      error: messageOf(error),
    };
  }
}

function stageRemark(remark: Remark): StageRemark {
  return {
    kind: remark.kind,
    node: remark.node === null ? null : `v${remark.node}`,
    message: remark.message,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function analysisName(id: { description?: string | undefined }): string {
  return id.description ?? "anonymous";
}

type TracedShape = {
  readonly edge?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly property?: unknown;
  readonly properties?: unknown;
};

function shapeEdgeOf(category: string, data: unknown): ShapeEdge | null {
  if (category !== "hidden_class" || typeof data !== "object" || data === null) return null;
  const traced = data as TracedShape;
  if (typeof traced.from !== "number" || typeof traced.to !== "number") return null;
  if (typeof traced.property !== "string") return null;
  return {
    kind: traced.edge === "delete" ? "delete" : "add",
    from: traced.from,
    to: traced.to,
    property: traced.property,
    properties: typeof traced.properties === "number" ? traced.properties : null,
  };
}

type TracedDeopt = {
  readonly function?: unknown;
  readonly reason?: unknown;
  readonly nodeId?: unknown;
  readonly opcode?: unknown;
  readonly line?: unknown;
  readonly candidates?: unknown;
};

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function valueName(value: unknown): string | null {
  return typeof value === "number" ? `v${value}` : null;
}

function deoptOriginOf(category: string, data: unknown): DeoptOrigin | null {
  if (category !== "deopt" || typeof data !== "object" || data === null) return null;
  const traced = data as TracedDeopt;
  if (typeof traced.reason !== "string") return null;
  const candidates = Array.isArray(traced.candidates) ? traced.candidates : [];
  return {
    owner: textOr(traced.function, "<anonymous>"),
    reason: traced.reason,
    node: valueName(traced.nodeId),
    opcode: typeof traced.opcode === "string" ? traced.opcode : null,
    line: typeof traced.line === "number" ? traced.line : null,
    candidates: candidates.map(valueName).filter((name): name is string => name !== null),
  };
}

function targets(): TargetInfo[] {
  const found: TargetInfo[] = [{ id: "wasm", pipeline: "jit", label: "JIT · wasm" }];
  for (const backend of createBackendRegistry().list()) {
    if (!isAotBackend(backend)) continue;
    const platform = backend.platform === null ? "portable" : `${backend.platform.os}-${backend.platform.arch}`;
    found.push({ id: backend.id, pipeline: "aot", label: `AOT · ${backend.id} (${platform})` });
  }
  return found;
}

function sourceLinesOf(graph: CFGFunction): Record<string, number> {
  const lines: Record<string, number> = {};
  const note = (node: { id: number; position: { line: number } | null }): void => {
    if (node.position !== null) lines[`v${node.id}`] = node.position.line;
  };
  for (const parameter of graph.parameters) note(parameter);
  for (const block of graph.blocks) {
    for (const node of block.nodes) note(node);
  }
  return lines;
}

class StageCollector {
  private readonly stages: Stage[] = [];
  private readonly middleEnd: ReadonlySet<string>;
  private ordinal = 0;

  constructor(options: CompilerOptions) {
    this.middleEnd = new Set([IR_BUILDER_STAGE, ...middleEndPassNames(options)]);
  }

  recording = true;

  plain(
    stage: Omit<
      Stage,
      "ordinal" | "positions" | "owner" | "failed" | "remarks" | "requires" | "allocation"
    > & {
      owner?: string;
      failed?: boolean;
    },
  ): void {
    this.stages.push({
      ...stage,
      failed: stage.failed ?? false,
      owner: stage.owner ?? stage.title,
      requires: NO_ANALYSES,
      remarks: NO_REMARKS,
      allocation: null,
      positions: NO_POSITIONS,
      ordinal: this.ordinal++,
    });
  }

  private readonly executed = new Map<string, ExecutedGraph>();
  private readonly allocations = new Map<string, AllocationReport>();

  allocated = (report: AllocationReport): void => {
    this.allocations.set(report.symbol, report);
  };

  private capture(record: PassTraceRecord<CFGFunction>): void {
    const owner = record.graph.name;
    const held = this.executed.get(owner);
    if (held === undefined) {
      this.executed.set(owner, {
        ordinal: record.ordinal,
        pass: record.pass,
        text: printIR(record.graph),
        positions: sourceLinesOf(record.graph),
        frozen: false,
      });
      return;
    }
    if (held.frozen) return;
    if (record.ordinal <= held.ordinal) {
      held.frozen = true;
      return;
    }
    held.ordinal = record.ordinal;
    if (!record.changed) return;
    held.pass = record.pass;
    held.text = printIR(record.graph);
    held.positions = sourceLinesOf(record.graph);
  }

  executedStages(): void {
    for (const [owner, held] of this.executed) {
      this.stages.push({
        id: `executed/${owner}`,
        group: "executed",
        kind: "ir",
        title: owner,
        subtitle: `as the engine ran it, after ${held.pass}`,
        owner,
        ordinal: this.ordinal++,
        changed: true,
        failed: false,
        text: held.text,
        passName: EXECUTED_PASS,
        metrics: null,
        requires: NO_ANALYSES,
        invalidated: [],
        remarks: NO_REMARKS,
        allocation: null,
        positions: held.positions,
      });
    }
  }

  tracer = (record: PassTraceRecord<CFGFunction>): void => {
    if (!this.recording) {
      this.capture(record);
      return;
    }
    const owner = record.graph.name;
    const group: StageGroup = this.middleEnd.has(record.pass) ? "middle-end" : "lowering";
    const previous = this.lastTextOf("ir", owner);
    this.stages.push({
      id: `${group}/${this.ordinal}-${owner}-${record.pass}`,
      group,
      kind: "ir",
      title: record.pass,
      subtitle: owner,
      owner,
      ordinal: this.ordinal++,
      changed: record.changed,
      failed: false,
      text: record.changed || previous === null ? printIR(record.graph) : previous,
      passName: record.pass,
      metrics: { nodesBefore: record.nodesBefore, nodesAfter: record.nodesAfter },
      requires: record.requires.map(analysisName),
      invalidated: record.invalidated.map(analysisName),
      remarks: record.remarks.map(stageRemark),
      allocation: null,
      positions: sourceLinesOf(record.graph),
    });
  };

  machine = (record: MachineTraceRecord): void => {
    const text = printMachineFunction(record.fn);
    this.stages.push({
      id: `machine/${this.ordinal}-${record.symbol}-${record.after}`,
      group: "machine",
      kind: "machine",
      title: record.after,
      subtitle: `${record.symbol} · ${record.stage}`,
      owner: record.symbol,
      ordinal: this.ordinal++,
      changed: text !== this.lastTextOf("machine", record.symbol),
      failed: false,
      text,
      passName: record.after,
      metrics: null,
      requires: NO_ANALYSES,
      invalidated: [],
      remarks: NO_REMARKS,
      allocation: this.allocations.get(record.symbol) ?? null,
      positions: NO_POSITIONS,
    });
  };

  module = (record: ModuleTraceRecord): void => {
    const text = printModuleIR(record.module);
    this.stages.push({
      id: `aot-module/${this.ordinal}-${record.stage}`,
      group: "module",
      kind: "ir",
      title: record.stage,
      subtitle: `${record.module.units.length} units`,
      owner: MODULE_OWNER,
      ordinal: this.ordinal++,
      changed: text !== this.lastTextOf("ir", MODULE_OWNER),
      failed: false,
      text,
      passName: record.stage,
      metrics: null,
      requires: NO_ANALYSES,
      invalidated: [],
      remarks: record.remarks.map(stageRemark),
      allocation: null,
      positions: NO_POSITIONS,
    });
  };

  produced(owner: string): boolean {
    return this.stages.some((stage) => stage.kind === "ir" && stage.owner === owner);
  }

  get broke(): boolean {
    return this.stages.some((stage) => stage.failed);
  }

  private lastTextOf(kind: Stage["kind"], owner: string): string | null {
    for (let at = this.stages.length - 1; at >= 0; at--) {
      const stage = this.stages[at]!;
      if (stage.kind === kind && stage.owner === owner) return stage.text;
    }
    return null;
  }

  done(): readonly Stage[] {
    return this.stages;
  }
}

function frontendStages(collect: StageCollector, source: string): void {
  stageOrExplain(collect, "frontend/tokens", "tokenize", () => {
    const tokens = tokenize(source);
    return { subtitle: `${tokens.length} tokens`, text: tokens.map(formatToken).join("\n") };
  });

  stageOrExplain(collect, "frontend/ast", "parse", () => ({
    subtitle: "abstract syntax tree",
    text: printAst(parse(source)),
  }));

  stageOrExplain(collect, "frontend/check", "typecheck", () => {
    const diagnostics = [...diagnoseSource(source, createReactiveCheckOptions())];
    return {
      kind: "diagnostics",
      changed: diagnostics.length > 0,
      subtitle: diagnostics.length === 0 ? "no diagnostics" : `${diagnostics.length} diagnostics`,
      text:
        diagnostics.length === 0
          ? "The checker reported nothing."
          : diagnostics
              .map((item) => `${item.severity} ${item.line}:${item.column}  ${item.message}`)
              .join("\n"),
    };
  });
}

type FrontendResult = {
  readonly subtitle: string;
  readonly text: string;
  readonly kind?: Stage["kind"];
  readonly changed?: boolean;
  readonly failed?: boolean;
};

function stageOrExplain(
  collect: StageCollector,
  id: string,
  title: VisualizerPassName,
  build: () => FrontendResult,
): void {
  let result: FrontendResult;
  try {
    result = build();
  } catch (error) {
    result = {
      subtitle: "failed",
      text: messageOf(error),
      kind: "diagnostics",
      changed: true,
      failed: true,
    };
  }
  collect.plain({
    id,
    group: "frontend",
    kind: result.kind ?? "text",
    title,
    subtitle: result.subtitle,
    changed: result.changed ?? true,
    failed: result.failed ?? false,
    text: result.text,
    passName: title,
    metrics: null,
    invalidated: [],
  });
}

function formatToken(token: Token): string {
  const where = `${token.line}:${token.column}`;
  return `${where.padStart(7)}  ${token.type.padEnd(14)} ${JSON.stringify(String(token.value))}`;
}

function bytecodeStages(collect: StageCollector, functions: readonly CompiledFn[]): void {
  for (const compiled of functions) {
    const name = compiled.name ?? "<anonymous>";
    collect.plain({
      id: `bytecode/${name}`,
      group: "bytecode",
      kind: "bytecode",
      title: name,
      subtitle: compiled.feedbackVector === null ? "no feedback yet" : "has feedback",
      changed: true,
      text: compiled.disassemble(),
      passName: "bytecode" satisfies VisualizerPassName,
      metrics: null,
      invalidated: [],
    });
  }
}

function uniqueByName(functions: readonly CompiledFn[]): CompiledFn[] {
  const seen = new Map<string, CompiledFn>();
  for (const compiled of functions) {
    const name = compiled.name ?? "<anonymous>";
    if (!seen.has(name)) seen.set(name, compiled);
  }
  return [...seen.values()];
}

function run(request: RunRequest): RunResult {
  const started = performance.now();
  const events: RuntimeEvent[] = [];
  const spent = new Map<string, number>();
  const dropped = new Map<string, number>();
  const printed = new OutputSink();
  const shapes: ShapeEdge[] = [];
  const options = compilerOptions(request.optLevel);
  const collect = new StageCollector(options);
  let outcome: Outcome = { error: null, runError: null };

  try {
    frontendStages(collect, request.source);
  } catch (thrown) {
    return report(collect, events, dropped, printed, shapes, { error: messageOf(thrown), runError: null }, started);
  }

  const traced: CompilerOptions = {
    ...options,
    passTracer: (record) => collect.tracer(record as PassTraceRecord<CFGFunction>),
  };

  const engine = new Engine({
    ...createReactiveTeraOptions({ nativeToTagged, taggedToNative }),
    backends: createBackendRegistry(),
    typecheck: "off",
    tieringPolicy: HOT_TIERING,
    trace: true,
    traceCategories: TRACED_CATEGORIES,
    compilerOptions: traced,
    output: printed.write,
    onTrace: (event) => {
      const budget = EVENT_BUDGET[event.category] ?? DEFAULT_EVENT_BUDGET;
      const taken = spent.get(event.category) ?? 0;
      if (taken >= budget) {
        dropped.set(event.category, (dropped.get(event.category) ?? 0) + 1);
        return;
      }
      const shape = shapeEdgeOf(event.category, event.data);
      if (shape !== null && shapes.length < SHAPE_BUDGET) shapes.push(shape);
      spent.set(event.category, taken + 1);
      events.push({
        category: event.category,
        message: event.message,
        at: event.timestamp,
        origin: deoptOriginOf(event.category, event.data),
      });
    },
  });

  try {
    outcome =
      request.pipeline === "aot"
        ? runAot(engine, collect, request, printed)
        : runJit(engine, collect, request);
  } catch (thrown) {
    outcome = { ...outcome, error: messageOf(thrown) };
  }

  return report(collect, events, dropped, printed, shapes, outcome, started);
}

function report(
  collect: StageCollector,
  events: readonly RuntimeEvent[],
  dropped: ReadonlyMap<string, number>,
  printed: OutputSink,
  shapes: readonly ShapeEdge[],
  outcome: Outcome,
  started: number,
): RunResult {
  return {
    stages: collect.done(),
    events,
    dropped: Object.fromEntries(dropped),
    output: printed.lines,
    outputDropped: printed.dropped,
    shapes,
    error: outcome.error,
    runError: outcome.runError,
    elapsedMs: performance.now() - started,
  };
}

function runJit(engine: Engine, collect: StageCollector, request: RunRequest): Outcome {
  let runError: string | null = null;
  let error: string | null = null;

  collect.recording = false;
  try {
    engine.run(request.source);
  } catch (thrown) {
    if (collect.broke) error = messageOf(thrown);
    else runError = messageOf(thrown);
  }
  collect.recording = true;
  collect.executedStages();

  if (error !== null) return { error, runError: null };

  const functions = uniqueByName(engine.collectFunctions());
  bytecodeStages(collect, functions);

  const hot = functions.filter((compiled) => compiled.feedbackVector !== null);
  if (hot.length === 0) {
    return {
      runError,
      error:
        runError !== null
          ? null
          : "No function collected feedback: call a function so the JIT has something to optimize.",
    };
  }
  for (const compiled of hot) {
    const name = compiled.name ?? "<anonymous>";
    engine.optimizeFunction(compiled);
    if (collect.produced(name)) continue;
    collect.plain({
      id: `declined/${name}`,
      group: "bytecode",
      kind: "diagnostics",
      title: name,
      subtitle: "no graph",
      changed: true,
      text: `${name} collected feedback and was handed to the optimizer, which returned no graph for it. The interpreter keeps running this function; nothing below this line applies to it.`,
      passName: "declined" satisfies VisualizerPassName,
      metrics: null,
      invalidated: [],
      owner: name,
    });
  }
  return { error: null, runError };
}

function isCompiled(value: unknown): value is CompiledFn {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CompiledFn).disassemble === "function"
  );
}

function nestedFunctions(root: CompiledFn): CompiledFn[] {
  const found: CompiledFn[] = [root];
  for (const constant of root.constants) {
    if (isCompiled(constant)) found.push(...nestedFunctions(constant));
  }
  return found;
}

function runAot(
  engine: Engine,
  collect: StageCollector,
  request: RunRequest,
  printed: OutputSink,
): Outcome {
  const entry = engine.compile(request.source);
  bytecodeStages(collect, uniqueByName(nestedFunctions(entry)));

  const program = engine.compileAot(request.source, {
    backend: request.target,
    compilerOptions: {
      ...compilerOptions(request.optLevel),
      passTracer: (record) => collect.tracer(record as PassTraceRecord<CFGFunction>),
      machineTracer: collect.machine,
      allocationTracer: collect.allocated,
      moduleTracer: collect.module,
    },
  });

  for (const file of program.files) {
    const text = typeof file.contents === "string";
    collect.plain({
      id: `codegen/${file.name}`,
      group: "codegen",
      kind: "text",
      title: file.name,
      subtitle: text ? `${file.contents.length} chars` : `${file.contents.length} bytes`,
      changed: true,
      text: typeof file.contents === "string" ? file.contents : hexDump(file.contents),
      passName: "codegen" satisfies VisualizerPassName,
      metrics: null,
      invalidated: [],
    });
  }

  return {
    error:
      program.skipped.length === 0
        ? null
        : program.skipped.map((skip) => `${skip.name}: ${skip.reason}`).join("\n"),
    runError: execute(request.source, printed),
  };
}

function execute(source: string, printed: OutputSink): string | null {
  const engine = new Engine({
    ...createReactiveTeraOptions({ nativeToTagged, taggedToNative }),
    typecheck: "off",
    output: printed.write,
  });
  try {
    engine.run(source);
    return null;
  } catch (thrown) {
    return messageOf(thrown);
  }
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const slice = [...bytes.slice(at, at + 16)];
    const hex = slice.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const text = slice.map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${at.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${text}`);
  }
  return lines.join("\n");
}
