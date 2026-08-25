import { createReactiveCheckOptions, createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import {
  compilerOptions,
  createBackendRegistry,
  diagnoseSource,
  Engine,
  IR_BUILDER_STAGE,
  isAotBackend,
  afterNamedPass,
  middleEndPassNames,
  nativeToTagged,
  parse,
  printAst,
  printIR,
  printMachineFunction,
  printModuleIR,
  taggedToNative,
  tokenize,
  type CFGFunction,
  type CompilerOptions,
  type MachineTraceRecord,
  type ModuleTraceRecord,
  type PassTraceRecord,
  type Token,
} from "tera";
import {
  NO_POSITIONS,
  type LabRequest,
  type LabResult,
  type RunRequest,
  type RunResult,
  type RuntimeEvent,
  type Stage,
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
const MODULE_OWNER = "<module>";

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
    return { before: request.text, after: afterNamedPass(request.text, request.pass, options), error: null };
  } catch (error) {
    return { before: request.text, after: request.text, error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    stage: Omit<Stage, "ordinal" | "positions" | "owner" | "failed"> & {
      owner?: string;
      failed?: boolean;
    },
  ): void {
    this.stages.push({
      ...stage,
      failed: stage.failed ?? false,
      owner: stage.owner ?? stage.title,
      positions: NO_POSITIONS,
      ordinal: this.ordinal++,
    });
  }

  tracer = (record: PassTraceRecord<CFGFunction>): void => {
    if (!this.recording) return;
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
      invalidated: record.invalidated.map((id) => id.description ?? "anonymous"),
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
      invalidated: [],
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
      invalidated: [],
      positions: NO_POSITIONS,
    });
  };

  produced(owner: string): boolean {
    return this.stages.some((stage) => stage.kind === "ir" && stage.owner === owner);
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
  const options = compilerOptions(request.optLevel);
  const collect = new StageCollector(options);
  let error: string | null = null;

  try {
    frontendStages(collect, request.source);
  } catch (thrown) {
    return {
      stages: collect.done(),
      events,
      dropped: {},
      error: messageOf(thrown),
      elapsedMs: performance.now() - started,
    };
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
    output: () => undefined,
    onTrace: (event) => {
      const budget = EVENT_BUDGET[event.category] ?? DEFAULT_EVENT_BUDGET;
      const taken = spent.get(event.category) ?? 0;
      if (taken >= budget) {
        dropped.set(event.category, (dropped.get(event.category) ?? 0) + 1);
        return;
      }
      spent.set(event.category, taken + 1);
      events.push({ category: event.category, message: event.message, at: event.timestamp });
    },
  });

  try {
    if (request.pipeline === "aot") error = runAot(engine, collect, request);
    else error = runJit(engine, collect, request);
  } catch (thrown) {
    error = messageOf(thrown);
  }

  return {
    stages: collect.done(),
    events,
    dropped: Object.fromEntries(dropped),
    error,
    elapsedMs: performance.now() - started,
  };
}

function runJit(engine: Engine, collect: StageCollector, request: RunRequest): string | null {
  let error: string | null = null;

  collect.recording = false;
  try {
    engine.run(request.source);
  } catch (thrown) {
    error = messageOf(thrown);
  }
  collect.recording = true;

  const functions = uniqueByName(engine.collectFunctions());
  bytecodeStages(collect, functions);

  const hot = functions.filter((compiled) => compiled.feedbackVector !== null);
  if (hot.length === 0) {
    return error ?? "No function collected feedback: call a function so the JIT has something to optimize.";
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
  return error;
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

function runAot(engine: Engine, collect: StageCollector, request: RunRequest): string | null {
  const entry = engine.compile(request.source);
  bytecodeStages(collect, uniqueByName(nestedFunctions(entry)));

  const program = engine.compileAot(request.source, {
    backend: request.target,
    compilerOptions: {
      ...compilerOptions(request.optLevel),
      passTracer: (record) => collect.tracer(record as PassTraceRecord<CFGFunction>),
      machineTracer: collect.machine,
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

  return program.skipped.length === 0
    ? null
    : program.skipped.map((skip) => `${skip.name}: ${skip.reason}`).join("\n");
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
