import { Engine } from "../api/engine.js";
import type { CompileOptions, EngineOptions } from "../api/engine.js";
import { DebugController } from "./runtime.js";
import type {
  DebugPauseEvent,
  DebugPauseHandler,
  RuntimeDebugger,
} from "./runtime.js";

export type TeraDebugSessionOptions = Omit<EngineOptions, "debugger"> & {
  engine?: Engine;
  onPause?: DebugPauseHandler;
  pauseOnEntry?: boolean;
  enabled?: boolean;
  forceInterpreter?: boolean;
};

export class TeraDebugSession {
  readonly engine: Engine;
  readonly controller: DebugController;
  readonly pauses: DebugPauseEvent[];

  constructor(options: TeraDebugSessionOptions = {}) {
    const {
      engine,
      onPause,
      pauseOnEntry,
      enabled,
      forceInterpreter,
      ...engineOptions
    } = options;
    this.pauses = [];
    this.controller = new DebugController({
      pauseOnEntry,
      enabled,
      forceInterpreter,
      onPause: (event, controller) => {
        this.pauses.push(event);
        return onPause?.(event, controller);
      },
    });
    this.engine = engine ?? new Engine({
      ...engineOptions,
      debugger: this.controller,
    });
    if (engine) this.engine.setDebugger(this.controller);
  }

  setDebugger(debuggerHook: RuntimeDebugger | null): void {
    this.engine.setDebugger(debuggerHook);
  }

  run(source: string, options: CompileOptions = {}) {
    return this.engine.run(source, options);
  }

  runValue(source: string, options: CompileOptions = {}) {
    return this.engine.runValue(source, options);
  }

  runNative(source: string, options: CompileOptions = {}) {
    return this.engine.runNative(source, options);
  }

  dispose(): void {
    this.engine.setDebugger(null);
  }
}

export * from "./runtime.js";
