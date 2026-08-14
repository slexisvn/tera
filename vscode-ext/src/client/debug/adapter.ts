import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { EventEmitter, type Event } from "vscode";
import type {
  DebugBindingSnapshot,
  DebugFrameSnapshot,
  DebugPauseEvent,
  DebugPropertySnapshot,
  DebugValueSnapshot,
} from "tera";
import { evaluateDebugExpression } from "./evaluate.ts";
import type {
  BreakpointSpec,
  DapBreakpoint,
  DapSource,
  EventMessage,
  LaunchArguments,
  ProtocolMessage,
  RequestMessage,
  ResponseMessage,
  WorkerEvent,
} from "./protocol.ts";
import { hasUnresolvedVariablePath, normalizeDebugPath } from "./paths.ts";

const THREAD_ID = 1;
const GLOBALS_REF = 2;
const FRAME_REF_BASE = 1000;
const VALUE_REF_BASE = 100000;
const COMMAND_NONE = 0;
const COMMAND_CONTINUE = 1;
const COMMAND_STEP_INTO = 2;
const COMMAND_STEP_OVER = 3;
const COMMAND_STEP_OUT = 4;
const COMMAND_QUIT = 5;
const STATE_COMMAND = 0;
const STATE_PAUSE = 1;

type SetBreakpointsArguments = {
  source?: DapSource;
  breakpoints?: Array<{
    line: number;
    column?: number;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
  }>;
  lines?: number[];
};

type StackTraceArguments = {
  startFrame?: number;
  levels?: number;
};

type ScopesArguments = {
  frameId: number;
};

type VariablesArguments = {
  variablesReference: number;
};

type EvaluateArguments = {
  expression: string;
  frameId?: number;
  context?: string;
};

function sourcePath(source: DapSource | undefined): string {
  return normalizeDebugPath(source?.path || source?.name || "");
}

function dapSource(path: string): DapSource {
  return { name: basename(path), path };
}

function requestArgs<T>(request: RequestMessage): T {
  return (request.arguments ?? {}) as T;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function frameReference(frameIndex: number): number {
  return FRAME_REF_BASE + frameIndex;
}

function frameIndex(reference: number): number {
  return reference - FRAME_REF_BASE;
}

function bindingVariable(binding: DebugBindingSnapshot, ref: number) {
  return {
    name: binding.name,
    value: binding.value.display,
    type: binding.value.tag,
    variablesReference: ref,
    evaluateName: binding.name,
  };
}

function propertyVariable(property: DebugPropertySnapshot, ref: number) {
  return {
    name: property.name,
    value: property.value.display,
    type: property.value.tag,
    variablesReference: ref,
  };
}

export class TeraDebugAdapter {
  private readonly emitter = new EventEmitter<ProtocolMessage>();
  readonly onDidSendMessage: Event<ProtocolMessage> = this.emitter.event;
  private readonly commandState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  private readonly breakpointsBySource = new Map<string, BreakpointSpec[]>();
  private seq = 1;
  private worker: Worker | null = null;
  private launchArguments: LaunchArguments | null = null;
  private configurationDone = false;
  private currentPause: DebugPauseEvent | null = null;
  private nextBreakpointId = 1;
  private nextValueReference = VALUE_REF_BASE;
  private readonly valueReferences = new Map<number, DebugValueSnapshot>();

  constructor(private readonly workerPath: string) {}

  handleMessage(message: ProtocolMessage): void {
    if (message.type !== "request") return;
    const request = message as RequestMessage;
    try {
      this.handleRequest(request);
    } catch (error) {
      this.sendResponse(request, undefined, false, messageOf(error));
    }
  }

  dispose(): void {
    this.resumeWorker(COMMAND_QUIT);
    void this.worker?.terminate();
    this.worker = null;
    this.emitter.dispose();
  }

  private handleRequest(request: RequestMessage): void {
    switch (request.command) {
      case "initialize":
        this.sendResponse(request, {
          supportsConfigurationDoneRequest: true,
          supportsStepInTargetsRequest: false,
          supportsEvaluateForHovers: true,
          supportsConditionalBreakpoints: true,
          supportsHitConditionalBreakpoints: true,
          supportsLogPoints: true,
          supportsSetVariable: false,
          supportsTerminateRequest: true,
        });
        this.sendEvent("initialized");
        break;
      case "launch":
        this.launchArguments = requestArgs<LaunchArguments>(request);
        this.sendResponse(request);
        this.startIfReady();
        break;
      case "configurationDone":
        this.configurationDone = true;
        this.sendResponse(request);
        this.startIfReady();
        break;
      case "setBreakpoints":
        this.setBreakpoints(request);
        break;
      case "setExceptionBreakpoints":
        this.sendResponse(request, { breakpoints: [] });
        break;
      case "threads":
        this.sendResponse(request, {
          threads: [{ id: THREAD_ID, name: "main" }],
        });
        break;
      case "stackTrace":
        this.stackTrace(request);
        break;
      case "scopes":
        this.scopes(request);
        break;
      case "variables":
        this.variables(request);
        break;
      case "evaluate":
        this.evaluate(request);
        break;
      case "continue":
        this.sendResponse(request, { allThreadsContinued: true });
        this.clearPause();
        this.resumeWorker(COMMAND_CONTINUE);
        break;
      case "next":
        this.sendResponse(request);
        this.clearPause();
        this.resumeWorker(COMMAND_STEP_OVER);
        break;
      case "stepIn":
        this.sendResponse(request);
        this.clearPause();
        this.resumeWorker(COMMAND_STEP_INTO);
        break;
      case "stepOut":
        this.sendResponse(request);
        this.clearPause();
        this.resumeWorker(COMMAND_STEP_OUT);
        break;
      case "disconnect":
        this.sendResponse(request);
        this.dispose();
        this.sendEvent("terminated");
        break;
      case "pause":
        this.sendResponse(request);
        Atomics.store(this.commandState, STATE_PAUSE, 1);
        break;
      default:
        this.sendResponse(request);
        break;
    }
  }

  private setBreakpoints(request: RequestMessage): void {
    const args = requestArgs<SetBreakpointsArguments>(request);
    const path = sourcePath(args.source);
    const sourceBreakpoints: Array<{
      line: number;
      column?: number;
      condition?: string;
      hitCondition?: string;
      logMessage?: string;
    }> =
      args.breakpoints ?? (args.lines ?? []).map((line) => ({ line }));
    const breakpoints = sourceBreakpoints.map((bp): BreakpointSpec => ({
      id: this.nextBreakpointId++,
      sourceName: path,
      line: bp.line,
      column: bp.column ?? null,
      condition: bp.condition,
      hitCondition: bp.hitCondition,
      logMessage: bp.logMessage,
    }));
    this.breakpointsBySource.set(path, breakpoints);
    this.worker?.postMessage({
      type: "setBreakpoints",
      breakpoints: this.allBreakpoints(),
    });
    this.sendResponse(request, {
      breakpoints: breakpoints.map((bp): DapBreakpoint => ({
        id: bp.id,
        verified: true,
        line: bp.line,
        column: bp.column ?? undefined,
        source: path ? dapSource(path) : undefined,
      })),
    });
  }

  private stackTrace(request: RequestMessage): void {
    const pause = this.currentPause;
    if (!pause) {
      this.sendResponse(request, { stackFrames: [], totalFrames: 0 });
      return;
    }
    const args = requestArgs<StackTraceArguments>(request);
    const frames = pause.snapshot.frames
      .map((frame, index) => ({ frame, index }))
      .reverse();
    const start = args.startFrame ?? 0;
    const end = args.levels ? start + args.levels : frames.length;
    const stackFrames = frames.slice(start, end).map(({ frame, index }) => ({
      id: frameReference(index),
      name: frame.functionName,
      source: frame.location ? dapSource(frame.location.sourceName) : undefined,
      line: frame.location?.line ?? 1,
      column: frame.location?.column ?? 1,
      instructionPointerReference: String(frame.pc),
    }));
    this.sendResponse(request, {
      stackFrames,
      totalFrames: frames.length,
    });
  }

  private scopes(request: RequestMessage): void {
    const args = requestArgs<ScopesArguments>(request);
    const frame = this.frameForReference(args.frameId);
    this.sendResponse(request, {
      scopes: frame
        ? [{
            name: "Locals",
            variablesReference: args.frameId,
            expensive: false,
          }, {
            name: "Globals",
            variablesReference: GLOBALS_REF,
            expensive: true,
          }]
        : [],
    });
  }

  private variables(request: RequestMessage): void {
    const args = requestArgs<VariablesArguments>(request);
    if (args.variablesReference === GLOBALS_REF) {
      this.sendResponse(request, {
        variables: (this.currentPause?.snapshot.globals ?? [])
          .map((binding) => bindingVariable(binding, this.referenceForValue(binding.value))),
      });
      return;
    }
    if (args.variablesReference >= VALUE_REF_BASE) {
      const value = this.valueReferences.get(args.variablesReference);
      this.sendResponse(request, {
        variables: (value?.children ?? [])
          .map((property) => propertyVariable(property, this.referenceForValue(property.value))),
      });
      return;
    }
    const frame = this.frameForReference(args.variablesReference);
    this.sendResponse(request, {
      variables: frame
        ? frame.locals
            .filter((binding) => !binding.internal)
            .map((binding) => bindingVariable(binding, this.referenceForValue(binding.value)))
        : [],
    });
  }

  private evaluate(request: RequestMessage): void {
    const args = requestArgs<EvaluateArguments>(request);
    const frame = args.frameId ? this.frameForReference(args.frameId) : this.currentPause?.snapshot.frames.at(-1);
    try {
      const result = evaluateDebugExpression(args.expression, {
        locals: frame?.locals.filter((binding) => !binding.internal) ?? [],
        globals: this.currentPause?.snapshot.globals ?? [],
      });
      this.sendResponse(request, {
        result: result.display,
        type: result.tag,
        variablesReference: this.referenceForValue(result),
        namedVariables: result.children?.length ?? 0,
        indexedVariables: result.children?.length ?? 0,
      });
    } catch (error) {
      this.sendResponse(request, undefined, false, messageOf(error));
    }
  }

  private frameForReference(reference: number): DebugFrameSnapshot | null {
    const frames = this.currentPause?.snapshot.frames;
    if (!frames) return null;
    return frames[frameIndex(reference)] ?? null;
  }

  private startIfReady(): void {
    if (!this.launchArguments || !this.configurationDone || this.worker) return;
    const program = this.launchArguments.program;
    if (!program || hasUnresolvedVariablePath(program)) {
      this.sendEvent("output", {
        category: "stderr",
        output: "Missing Tera program path. Open a .tera file or set launch.program.\n",
      });
      this.sendEvent("terminated");
      return;
    }
    const rawCwd = hasUnresolvedVariablePath(this.launchArguments.cwd)
      ? undefined
      : this.launchArguments.cwd;
    const normalizedProgram = normalizeDebugPath(program, rawCwd);
    const cwd = normalizeDebugPath(rawCwd, dirname(normalizedProgram)) || dirname(normalizedProgram);
    const breakpoints = this.allBreakpoints();
    const launch: LaunchArguments = {
      ...this.launchArguments,
      cwd: cwd || undefined,
      program: normalizedProgram,
      stopOnEntry: this.launchArguments.stopOnEntry ?? false,
    };
    this.worker = new Worker(pathToFileURL(this.workerPath), {
      workerData: { commandBuffer: this.commandState.buffer },
    });
    this.worker.on("message", (event: WorkerEvent) => this.handleWorkerEvent(event));
    this.worker.on("error", (error) => {
      this.sendEvent("output", {
        category: "stderr",
        output: `${messageOf(error)}\n`,
      });
      this.sendEvent("terminated");
    });
    this.worker.on("exit", (code) => {
      if (code !== 0) {
        this.sendEvent("output", {
          category: "stderr",
          output: `Tera debug worker exited with code ${code}.\n`,
        });
      }
    });
    this.worker.postMessage({
      type: "start",
      launch,
      breakpoints,
    });
  }

  private handleWorkerEvent(event: WorkerEvent): void {
    switch (event.type) {
      case "started":
        break;
      case "stopped":
        this.valueReferences.clear();
        this.nextValueReference = VALUE_REF_BASE;
        this.currentPause = event.event as DebugPauseEvent;
        this.sendEvent("stopped", {
          reason: this.currentPause.reason,
          threadId: THREAD_ID,
          allThreadsStopped: true,
          description: this.currentPause.reason,
        });
        break;
      case "output":
        this.sendEvent("output", {
          category: event.category ?? "stdout",
          output: event.text.endsWith("\n") ? event.text : `${event.text}\n`,
        });
        break;
      case "error":
        this.sendEvent("output", {
          category: "stderr",
          output: `${event.message}\n`,
        });
        break;
      case "terminated":
        this.sendEvent("terminated");
        break;
    }
  }

  private allBreakpoints(): BreakpointSpec[] {
    return [...this.breakpointsBySource.values()].flat();
  }

  private referenceForValue(value: DebugValueSnapshot): number {
    if (!value.children || value.children.length === 0) return 0;
    const ref = this.nextValueReference++;
    this.valueReferences.set(ref, value);
    return ref;
  }

  private clearPause(): void {
    this.currentPause = null;
    this.valueReferences.clear();
    this.nextValueReference = VALUE_REF_BASE;
  }

  private resumeWorker(command: number): void {
    if (!this.worker) return;
    Atomics.store(this.commandState, STATE_COMMAND, command || COMMAND_NONE);
    Atomics.notify(this.commandState, STATE_COMMAND);
  }

  private sendResponse(
    request: RequestMessage,
    body?: unknown,
    success = true,
    message?: string,
  ): void {
    const response: ResponseMessage = {
      seq: this.seq++,
      type: "response",
      request_seq: request.seq,
      success,
      command: request.command,
    };
    if (body !== undefined) response.body = body;
    if (message) response.message = message;
    this.emitter.fire(response);
  }

  private sendEvent(eventName: string, body?: unknown): void {
    const event: EventMessage = {
      seq: this.seq++,
      type: "event",
      event: eventName,
    };
    if (body !== undefined) event.body = body;
    this.emitter.fire(event);
  }
}
