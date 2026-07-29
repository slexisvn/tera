import type { TaggedValue } from "../core/value/index.js";
import {
  getPayload,
  getTag,
  isArray,
  isBool,
  isDouble,
  isFunction,
  isNull,
  isNumber,
  isObject,
  isSmi,
  isString,
  isUndefined,
  toDisplayString,
} from "../core/value/index.js";
import type { RegisterFrame, RegisterValue } from "../bytecode/register/interpreter/frame.js";
import { isTDZUninitialized } from "../bytecode/register/interpreter/frame.js";
import type { SourceMapEntry } from "../bytecode/register/ops/bytecode.js";

export const DEBUG_EVAL_SOURCE = "<eval>";

const BREAKPOINT_ANY_COLUMN = -1;
const KEY_SEPARATOR = "\u0000";
const MAX_DEBUG_CHILDREN = 64;
const MAX_DEBUG_DEPTH = 2;

export type DebugCommand = "continue" | "stepInto" | "stepOver" | "stepOut";
export type DebugPauseReason = "entry" | "breakpoint" | "step" | "pause";

export type DebugSourceLocation = {
  sourceName: string;
  line: number;
  column: number;
  pc: number;
  functionId: number;
  functionName: string;
};

export type DebugBreakpoint = {
  id: number;
  sourceName: string;
  line: number;
  column: number | null;
  enabled: boolean;
};

export type DebugValueSnapshot = {
  tag: string;
  display: string;
  raw?: string | number | boolean | null;
  children?: DebugPropertySnapshot[];
};

export type DebugPropertySnapshot = {
  name: string;
  value: DebugValueSnapshot;
};

export type DebugBindingSnapshot = {
  name: string;
  slot: number;
  kind: string;
  internal?: boolean;
  value: DebugValueSnapshot;
};

export type DebugFrameSnapshot = {
  functionName: string;
  functionId: number;
  pc: number;
  location: DebugSourceLocation | null;
  accumulator: DebugValueSnapshot;
  locals: DebugBindingSnapshot[];
};

export type DebugSnapshot = {
  callStack: string[];
  frames: DebugFrameSnapshot[];
  globals: DebugBindingSnapshot[];
};

export type DebugPauseEvent = {
  reason: DebugPauseReason;
  location: DebugSourceLocation;
  breakpoint: DebugBreakpoint | null;
  snapshot: DebugSnapshot;
};

export type DebugRuntimeView = {
  activeFrames: RegisterFrame[];
  callStack: string[];
  globalCells?: {
    cells: Iterable<[string, { value: TaggedValue | undefined }]>;
  };
};

export type DebugPauseHandler = (event: DebugPauseEvent, controller: DebugController) => DebugCommand | void;

export type RuntimeDebugger = {
  enabled: boolean;
  forceInterpreter: boolean;
  beforeInstruction(runtime: DebugRuntimeView, frame: RegisterFrame, pc: number): void;
};

type StepMode = Exclude<DebugCommand, "continue">;

type StepState = {
  mode: StepMode;
  depth: number;
  origin: string;
};

type BreakpointSkipState = {
  breakpoint: string;
  origin: string;
  depth: number;
};

type DebugControllerOptions = {
  onPause?: DebugPauseHandler;
  pauseOnEntry?: boolean;
  pauseRequested?: () => boolean;
  enabled?: boolean;
  forceInterpreter?: boolean;
};

function normalizeSourceName(sourceName: string | null | undefined): string {
  return sourceName || DEBUG_EVAL_SOURCE;
}

function breakpointKey(sourceName: string, line: number, column: number | null): string {
  return [sourceName, line, column ?? BREAKPOINT_ANY_COLUMN].join(KEY_SEPARATOR);
}

function locationKey(location: DebugSourceLocation): string {
  return [
    location.sourceName,
    location.functionId,
    location.line,
    location.column,
  ].join(KEY_SEPARATOR);
}

function stepLocationKey(location: DebugSourceLocation): string {
  return [
    location.sourceName,
    location.functionId,
    location.line,
  ].join(KEY_SEPARATOR);
}

function breakpointLocationKey(location: DebugSourceLocation): string {
  return breakpointKey(location.sourceName, location.line, null);
}

function sourceLocation(
  frame: RegisterFrame,
  pc: number,
): DebugSourceLocation | null {
  const raw = frame.compiledFn.sourceMap[pc] as SourceMapEntry | undefined;
  if (!raw || typeof raw.line !== "number" || typeof raw.column !== "number") {
    return null;
  }
  return {
    sourceName: normalizeSourceName(raw.sourceName ?? frame.compiledFn.sourceName),
    line: raw.line,
    column: raw.column,
    pc,
    functionId: frame.compiledFn.id,
    functionName: frame.compiledFn.name || "<anonymous>",
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function visibleObjectProperties(value: TaggedValue, depth: number): DebugPropertySnapshot[] {
  const out: DebugPropertySnapshot[] = [];
  if (isArray(value)) {
    const arr = getPayload(value);
    out.push({
      name: "length",
      value: {
        tag: "smi",
        display: String(arr.getLength()),
        raw: arr.getLength(),
      },
    });
    const limit = Math.min(arr.elements.length, MAX_DEBUG_CHILDREN);
    for (let i = 0; i < limit; i++) {
      const item = arr.elements[i];
      out.push({
        name: String(i),
        value: item === undefined
          ? { tag: "undefined", display: "undefined" }
          : taggedValueSnapshot(item, depth + 1),
      });
    }
    return out;
  }
  if (!isObject(value)) return out;
  const obj = getPayload(value);
  const names = obj.hiddenClass.getEnumerablePropertyNames();
  for (let i = 0; i < names.length && out.length < MAX_DEBUG_CHILDREN; i++) {
    const name = names[i]!;
    const child = obj.getProperty(name);
    out.push({
      name,
      value: child === undefined
        ? { tag: "undefined", display: "undefined" }
        : taggedValueSnapshot(child, depth + 1),
    });
  }
  return out;
}

function taggedValueSnapshot(value: TaggedValue, depth = 0): DebugValueSnapshot {
  try {
    const tag = String(getTag(value));
    const display = toDisplayString(value);
    if (isNumber(value)) {
      return { tag, display, raw: getPayload(value) as number };
    }
    if (isBool(value)) {
      return { tag, display, raw: !!getPayload(value) };
    }
    if (isString(value)) {
      return { tag, display, raw: getPayload(value) as string };
    }
    if (isNull(value)) {
      return { tag, display, raw: null };
    }
    if (isUndefined(value)) {
      return { tag, display };
    }
    if ((isArray(value) || isObject(value)) && depth < MAX_DEBUG_DEPTH) {
      return { tag, display, children: visibleObjectProperties(value, depth) };
    }
    if (isFunction(value)) {
      return { tag, display };
    }
    if (isSmi(value) || isDouble(value)) {
      return { tag, display, raw: Number(display) };
    }
    return { tag, display };
  } catch (error) {
    return { tag: "error", display: messageOf(error) };
  }
}

function registerValueSnapshot(value: RegisterValue): DebugValueSnapshot {
  if (isTDZUninitialized(value)) {
    return { tag: "tdz", display: "<uninitialized>" };
  }
  return taggedValueSnapshot(value as TaggedValue);
}

function slotValueSnapshot(frame: RegisterFrame, slot: number): DebugValueSnapshot {
  try {
    if (frame.hasUpvalues && frame.openUpvalues?.has(slot)) {
      const value = frame.openUpvalues.get(slot)!.get();
      return value === null
        ? { tag: "missing", display: "<missing>" }
        : registerValueSnapshot(value);
    }
    const raw = frame.registers[slot];
    return raw === undefined
      ? taggedValueSnapshot(frame.getReg(slot))
      : registerValueSnapshot(raw);
  } catch (error) {
    return { tag: "error", display: messageOf(error) };
  }
}

function frameSnapshot(frame: RegisterFrame, pc: number): DebugFrameSnapshot {
  const locals: DebugBindingSnapshot[] = [];
  for (let slot = 0; slot < frame.compiledFn.localNames.length; slot++) {
    const name = frame.compiledFn.localNames[slot];
    if (!name) continue;
    const value = slotValueSnapshot(frame, slot);
    if (value.tag === "tdz") continue;
    locals.push({
      name,
      slot,
      kind: frame.compiledFn.localBindingKinds[slot] || "temp",
      internal: name.includes("$"),
      value,
    });
  }
  return {
    functionName: frame.compiledFn.name || "<anonymous>",
    functionId: frame.compiledFn.id,
    pc,
    location: sourceLocation(frame, pc),
    accumulator: taggedValueSnapshot(frame.acc),
    locals,
  };
}

function globalSnapshots(runtime: DebugRuntimeView): DebugBindingSnapshot[] {
  const globals: DebugBindingSnapshot[] = [];
  if (!runtime.globalCells) return globals;
  let slot = 0;
  for (const [name, cell] of runtime.globalCells.cells) {
    if (cell.value === undefined) continue;
    globals.push({
      name,
      slot: slot++,
      kind: "global",
      value: taggedValueSnapshot(cell.value),
    });
  }
  return globals;
}

function runtimeSnapshot(
  runtime: DebugRuntimeView,
  currentFrame: RegisterFrame,
  currentPc: number,
): DebugSnapshot {
  const frames = runtime.activeFrames.map((frame) =>
    frameSnapshot(frame, frame === currentFrame ? currentPc : frame.pc),
  );
  return {
    callStack: runtime.callStack.slice(),
    frames,
    globals: globalSnapshots(runtime),
  };
}

class DebugBreakpointStore {
  private nextId = 1;
  private byId = new Map<number, DebugBreakpoint>();
  private byKey = new Map<string, number>();

  set(input: {
    sourceName?: string | null;
    line: number;
    column?: number | null;
    enabled?: boolean;
  }): DebugBreakpoint {
    const sourceName = normalizeSourceName(input.sourceName);
    const column = input.column ?? null;
    const key = breakpointKey(sourceName, input.line, column);
    const existingId = this.byKey.get(key);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId)!;
      existing.enabled = input.enabled ?? true;
      return existing;
    }
    const breakpoint = {
      id: this.nextId++,
      sourceName,
      line: input.line,
      column,
      enabled: input.enabled ?? true,
    };
    this.byId.set(breakpoint.id, breakpoint);
    this.byKey.set(key, breakpoint.id);
    return breakpoint;
  }

  delete(id: number): boolean {
    const breakpoint = this.byId.get(id);
    if (!breakpoint) return false;
    this.byId.delete(id);
    this.byKey.delete(breakpointKey(
      breakpoint.sourceName,
      breakpoint.line,
      breakpoint.column,
    ));
    return true;
  }

  deleteAt(sourceName: string | null | undefined, line: number, column?: number | null): boolean {
    const key = breakpointKey(normalizeSourceName(sourceName), line, column ?? null);
    const id = this.byKey.get(key);
    return id === undefined ? false : this.delete(id);
  }

  clear(): void {
    this.byId.clear();
    this.byKey.clear();
  }

  all(): DebugBreakpoint[] {
    return [...this.byId.values()];
  }

  match(location: DebugSourceLocation): DebugBreakpoint | null {
    const exact = this.matchKey(
      breakpointKey(location.sourceName, location.line, location.column),
    );
    if (exact) return exact;
    return this.matchKey(breakpointKey(location.sourceName, location.line, null));
  }

  private matchKey(key: string): DebugBreakpoint | null {
    const id = this.byKey.get(key);
    if (id === undefined) return null;
    const breakpoint = this.byId.get(id);
    return breakpoint?.enabled ? breakpoint : null;
  }
}

export class DebugController implements RuntimeDebugger {
  enabled: boolean;
  forceInterpreter: boolean;
  private readonly breakpoints = new DebugBreakpointStore();
  private readonly onPause: DebugPauseHandler | null;
  private readonly pauseRequested: (() => boolean) | null;
  private pauseOnEntry: boolean;
  private entryConsumed = false;
  private stepState: StepState | null = null;
  private breakpointSkip: BreakpointSkipState | null = null;
  lastPause: DebugPauseEvent | null = null;

  constructor(options: DebugControllerOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.forceInterpreter = options.forceInterpreter ?? true;
    this.onPause = options.onPause ?? null;
    this.pauseRequested = options.pauseRequested ?? null;
    this.pauseOnEntry = options.pauseOnEntry ?? false;
  }

  setBreakpoint(input: {
    sourceName?: string | null;
    line: number;
    column?: number | null;
    enabled?: boolean;
  }): DebugBreakpoint {
    return this.breakpoints.set(input);
  }

  clearBreakpoint(id: number): boolean {
    return this.breakpoints.delete(id);
  }

  clearBreakpointAt(sourceName: string | null | undefined, line: number, column?: number | null): boolean {
    return this.breakpoints.deleteAt(sourceName, line, column);
  }

  clearBreakpoints(): void {
    this.breakpoints.clear();
  }

  listBreakpoints(): DebugBreakpoint[] {
    return this.breakpoints.all();
  }

  continue(): void {
    this.stepState = null;
  }

  stepInto(event: DebugPauseEvent | null = this.lastPause): void {
    this.setStep("stepInto", event);
  }

  stepOver(event: DebugPauseEvent | null = this.lastPause): void {
    this.setStep("stepOver", event);
  }

  stepOut(event: DebugPauseEvent | null = this.lastPause): void {
    this.setStep("stepOut", event);
  }

  beforeInstruction(runtime: DebugRuntimeView, frame: RegisterFrame, pc: number): void {
    if (!this.enabled) return;
    const location = sourceLocation(frame, pc);
    if (!location) return;
    const currentKey = stepLocationKey(location);
    const depth = runtime.activeFrames.length;
    if (
      this.breakpointSkip &&
      !this.stepState &&
      depth <= this.breakpointSkip.depth &&
      currentKey !== this.breakpointSkip.origin
    ) {
      this.breakpointSkip = null;
    }
    const step = this.stepState;
    const stepHit = step ? this.stepHit(step, currentKey, depth) : false;
    const breakpoint = stepHit ? null : this.breakpoints.match(location);
    const breakpointKey = breakpointLocationKey(location);
    const breakpointHit =
      breakpoint && this.breakpointSkip?.breakpoint !== breakpointKey;
    const entryHit = this.pauseOnEntry && !this.entryConsumed;
    const pauseHit = this.pauseRequested?.() ?? false;
    if (!stepHit && !breakpointHit && !entryHit && !pauseHit) return;
    if (entryHit) this.entryConsumed = true;
    const event: DebugPauseEvent = {
      reason: breakpointHit
        ? "breakpoint"
        : entryHit
          ? "entry"
          : pauseHit
            ? "pause"
            : "step",
      location,
      breakpoint,
      snapshot: runtimeSnapshot(runtime, frame, pc),
    };
    this.lastPause = event;
    this.applyCommand(this.onPause?.(event, this) ?? "continue", event);
  }

  private stepHit(step: StepState, currentKey: string, depth: number): boolean {
    if (currentKey === step.origin) return false;
    if (step.mode === "stepInto") return true;
    if (step.mode === "stepOver") return depth <= step.depth;
    return depth < step.depth;
  }

  private setStep(mode: StepMode, event: DebugPauseEvent | null): void {
    if (!event) return;
    this.breakpointSkip = {
      breakpoint: breakpointLocationKey(event.location),
      origin: stepLocationKey(event.location),
      depth: event.snapshot.frames.length,
    };
    this.stepState = {
      mode,
      depth: event.snapshot.frames.length,
      origin: stepLocationKey(event.location),
    };
  }

  private applyCommand(command: DebugCommand, event: DebugPauseEvent): void {
    if (command === "continue") {
      this.continue();
      this.breakpointSkip = {
        breakpoint: breakpointLocationKey(event.location),
        origin: stepLocationKey(event.location),
        depth: event.snapshot.frames.length,
      };
    } else if (command === "stepInto") {
      this.stepInto(event);
    } else if (command === "stepOver") {
      this.stepOver(event);
    } else {
      this.stepOut(event);
    }
  }
}
