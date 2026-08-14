import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import { DebugController, Engine, nativeToTagged, taggedToNative } from "tera";
import type { DebugCommand, DebugPauseEvent } from "tera";
import { evaluateDebugExpression } from "./evaluate.ts";
import { normalizeDebugPath } from "./paths.ts";
import type { BreakpointSpec, WorkerCommand } from "./protocol.ts";

const COMMAND_NONE = 0;
const COMMAND_CONTINUE = 1;
const COMMAND_STEP_INTO = 2;
const COMMAND_STEP_OVER = 3;
const COMMAND_STEP_OUT = 4;
const COMMAND_QUIT = 5;
const STATE_COMMAND = 0;
const STATE_PAUSE = 1;

class DebugRunQuit extends Error {}

if (!parentPort) throw new Error("Tera debug worker requires a parent port");
const port = parentPort as NonNullable<typeof parentPort>;

const commandState = new Int32Array(workerData.commandBuffer as SharedArrayBuffer);
let controller: DebugController | null = null;
let breakpointSpecs = new Map<string, BreakpointSpec>();
let breakpointHits = new Map<string, number>();
let sourceRoot = process.cwd();

function commandFromCode(code: number): DebugCommand {
  switch (code) {
    case COMMAND_STEP_INTO:
      return "stepInto";
    case COMMAND_STEP_OVER:
      return "stepOver";
    case COMMAND_STEP_OUT:
      return "stepOut";
    case COMMAND_QUIT:
      throw new DebugRunQuit();
    case COMMAND_CONTINUE:
    default:
      return "continue";
  }
}

function waitForDebugCommand(): DebugCommand {
  while (true) {
    const current = Atomics.load(commandState, STATE_COMMAND);
    if (current !== COMMAND_NONE) {
      Atomics.store(commandState, STATE_COMMAND, COMMAND_NONE);
      return commandFromCode(current);
    }
    Atomics.wait(commandState, STATE_COMMAND, COMMAND_NONE);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function breakpointKey(spec: Pick<BreakpointSpec, "sourceName" | "line" | "column">): string {
  return `${spec.sourceName}\u0000${spec.line}\u0000${spec.column ?? -1}`;
}

function normalizeBreakpoint(bp: BreakpointSpec): BreakpointSpec {
  return {
    ...bp,
    sourceName: normalizeDebugPath(bp.sourceName, sourceRoot),
  };
}

function applyBreakpoints(breakpoints: BreakpointSpec[]): void {
  const normalized = breakpoints.map(normalizeBreakpoint);
  breakpointSpecs = new Map();
  breakpointHits = new Map();
  if (!controller) return;
  controller.clearBreakpoints();
  for (const bp of normalized) {
    breakpointSpecs.set(breakpointKey(bp), bp);
    controller.setBreakpoint({
      sourceName: bp.sourceName,
      line: bp.line,
      column: bp.column,
    });
  }
}

function eventBreakpointSpec(event: DebugPauseEvent): BreakpointSpec | null {
  if (!event.breakpoint) return null;
  const exact = breakpointSpecs.get(breakpointKey(event.breakpoint));
  if (exact) return exact;
  return breakpointSpecs.get(
    breakpointKey({
      sourceName: event.breakpoint.sourceName,
      line: event.breakpoint.line,
      column: null,
    }),
  ) ?? null;
}

function hitConditionPasses(condition: string | undefined, hits: number): boolean {
  if (!condition || condition.trim() === "") return true;
  const text = condition.trim();
  const match = /^(>=|<=|>|<|=|==|%)?\s*(\d+)$/.exec(text);
  if (!match) return hits === Number(text);
  const op = match[1] || "==";
  const value = Number(match[2]);
  if (op === ">=") return hits >= value;
  if (op === "<=") return hits <= value;
  if (op === ">") return hits > value;
  if (op === "<") return hits < value;
  if (op === "%") return value > 0 && hits % value === 0;
  return hits === value;
}

function conditionPasses(condition: string | undefined, event: DebugPauseEvent): boolean {
  if (!condition || condition.trim() === "") return true;
  const frame = event.snapshot.frames.at(-1);
  const result = evaluateDebugExpression(condition, {
    locals: frame?.locals.filter((binding) => !binding.internal) ?? [],
    globals: event.snapshot.globals,
  });
  if (typeof result.raw === "boolean") return result.raw;
  if (typeof result.raw === "number") return result.raw !== 0 && !Number.isNaN(result.raw);
  if (typeof result.raw === "string") return result.raw.length > 0;
  return result.tag !== "undefined" && result.tag !== "null";
}

function formatLogMessage(message: string, event: DebugPauseEvent): string {
  const frame = event.snapshot.frames.at(-1);
  return message.replace(/\{([^{}]+)\}/g, (_match, expression: string) => {
    try {
      return evaluateDebugExpression(expression, {
        locals: frame?.locals.filter((binding) => !binding.internal) ?? [],
        globals: event.snapshot.globals,
      }).display;
    } catch (error) {
      return `<${messageOf(error)}>`;
    }
  });
}

function shouldStopAtBreakpoint(event: DebugPauseEvent): boolean {
  if (event.reason !== "breakpoint") return true;
  const spec = eventBreakpointSpec(event);
  if (!spec) return true;
  const key = breakpointKey(spec);
  const hits = (breakpointHits.get(key) ?? 0) + 1;
  breakpointHits.set(key, hits);
  if (!hitConditionPasses(spec.hitCondition, hits)) return false;
  try {
    if (!conditionPasses(spec.condition, event)) return false;
  } catch (error) {
    port.postMessage({
      type: "output",
      category: "stderr",
      text: `Breakpoint condition failed: ${messageOf(error)}`,
    });
    return true;
  }
  if (spec.logMessage && spec.logMessage.trim() !== "") {
    port.postMessage({
      type: "output",
      category: "console",
      text: formatLogMessage(spec.logMessage, event),
    });
    return false;
  }
  return true;
}

function pauseHandler(event: DebugPauseEvent): DebugCommand {
  if (!shouldStopAtBreakpoint(event)) return "continue";
  port.postMessage({ type: "stopped", event });
  return waitForDebugCommand();
}

function startDebug(command: Extract<WorkerCommand, { type: "start" }>): void {
  const program = normalizeDebugPath(command.launch.program, command.launch.cwd);
  sourceRoot = normalizeDebugPath(command.launch.cwd, dirname(program)) || dirname(program);
  controller = new DebugController({
    pauseOnEntry: command.launch.stopOnEntry,
    pauseRequested: () => Atomics.exchange(commandState, STATE_PAUSE, 0) === 1,
    onPause: pauseHandler,
  });
  applyBreakpoints(command.breakpoints);

  const engine = new Engine({
    ...createReactiveTeraOptions({ nativeToTagged, taggedToNative }),
    typecheck: command.launch.typecheck ?? "off",
    debugger: controller,
    output: (text) => port.postMessage({
      type: "output",
      category: "stdout",
      text: String(text),
    }),
  });

  try {
    const source = readFileSync(program, "utf8");
    port.postMessage({ type: "started" });
    engine.runNative(source, { sourceName: program });
    port.postMessage({ type: "terminated" });
  } catch (error) {
    if (error instanceof DebugRunQuit) {
      port.postMessage({ type: "terminated" });
      return;
    }
    port.postMessage({
      type: "error",
      message: messageOf(error),
    });
    port.postMessage({ type: "terminated" });
  }
}

port.on("message", (command: WorkerCommand) => {
  if (command.type === "setBreakpoints") {
    applyBreakpoints(command.breakpoints);
    return;
  }
  startDebug(command);
});
