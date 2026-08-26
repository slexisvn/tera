import type { RuntimeValue, TaggedValue } from "../core/value/index.js";
import { FrameState } from "./frame-state.js";
import {
  RegisterFrame,
  MAX_DEOPT_COUNT,
  updateCallMode,
} from "../bytecode/register/interpreter/index.js";
import type {
  BaselineCode,
  OptimizedCode,
  RegisterCompiledFunction,
} from "../bytecode/register/ops/bytecode.js";
import type { Environment } from "../runtime/intrinsics/environment.js";
import { DeoptSignal } from "./signal.js";
import {
  ObjectMaterializer,
  withMaterializedAllocations,
} from "./materializer.js";
import { tracer } from "../core/tracing/index.js";
import { deoptOriginData, type DeoptSiteLookup } from "./origin.js";
import { dependencyRegistry } from "./dependencies.js";
import type { Dependency } from "./dependencies.js";
import {
  materializeFrameFromState,
  materializeFrameValue,
} from "./frame-materializer.js";

export { DeoptSignal };

export const DEOPT_SMI_CHECK_FAILED = "smi-check-failed";
export const DEOPT_NUMBER_CHECK_FAILED = "number-check-failed";
export const DEOPT_MAP_CHECK_FAILED = "map-check-failed";
export const DEOPT_ARRAY_CHECK_FAILED = "array-check-failed";
export const DEOPT_ELEMENTS_KIND_CHECK_FAILED = "elements-kind-check-failed";
export const DEOPT_BOUNDS_CHECK_FAILED = "bounds-check-failed";
export const DEOPT_OVERFLOW = "integer-overflow";
export const DEOPT_DIVISION_BY_ZERO = "division-by-zero";
export const DEOPT_MINUS_ZERO = "minus-zero";
export const DEOPT_WRONG_CALL_TARGET = "wrong-call-target";
export const DEOPT_GUARD_FAILURE = "guard-failure";
export const DEOPT_RUNTIME_STUB_FAILURE = "runtime-stub-failure";

type DeoptDependencyMetadata = {
  kind: string;
  id: string | number;
  version: string | number | null;
};

type CompiledFunctionLike = RegisterCompiledFunction & {
  optimizedCode?: OptimizedCode | null;
  optimizedDependencies?: Dependency[];
  lastDeoptReason?: string;
  baselineCode?: BaselineCode | null;
  optimizedDeoptSites?: DeoptSiteLookup | null;
};

type LazyDeoptInfo = {
  reason: string;
  dependency: DeoptDependencyMetadata | null;
  markedAt: number;
  functionId: number | undefined;
  functionName: string;
};

type TieringPolicyLike = {
  maxDeoptCount?: number;
  recordDeopt?: (compiledFn: CompiledFunctionLike, reason: string) => void;
};

type InterpreterLike = {
  tieringPolicy?: TieringPolicyLike | null;
  resumeAt(frame: RegisterFrame): TaggedValue;
};

type DeoptSignalLike = {
  reason: string;
  bytecodeOffset: number;
  frameStateId?: number;
  runtimeValues: Map<number, TaggedValue>;
  closureEnv?: Environment | null;
};

function getFunctionName(compiledFn: CompiledFunctionLike | null | undefined): string {
  return compiledFn?.name || "<anonymous>";
}

function deoptOrigin(
  compiledFn: CompiledFunctionLike | null | undefined,
  signal: DeoptSignalLike,
  bytecodeOffset: number,
) {
  return deoptOriginData({
    name: getFunctionName(compiledFn),
    reason: signal.reason,
    bytecodeOffset,
    frameStateId: signal.frameStateId ?? -1,
    sites: compiledFn?.optimizedDeoptSites ?? null,
  });
}

function requireCompiledFunction(
  compiledFn: CompiledFunctionLike | null,
  context: string,
): CompiledFunctionLike {
  if (!compiledFn) {
    throw new Error(`${context}: missing compiled function`);
  }
  return compiledFn;
}

export class LazyDeoptMarker {
  pendingDeopts: Map<CompiledFunctionLike, LazyDeoptInfo>;

  constructor() {
    this.pendingDeopts = new Map();
  }

  markForDeopt(
    compiledFn: CompiledFunctionLike,
    reason: string,
    dependency: DeoptDependencyMetadata | null = null,
  ): void {
    if (this.pendingDeopts.has(compiledFn)) return;
    this.pendingDeopts.set(compiledFn, {
      reason,
      dependency,
      markedAt: Date.now(),
      functionId: compiledFn.id,
      functionName: getFunctionName(compiledFn),
    });
    compiledFn.optimizedCode = null;
    updateCallMode(compiledFn);
    tracer.jitDeopt(getFunctionName(compiledFn), `Marked for lazy deopt: ${reason}`, -1);
  }

  hasPendingDeopt(compiledFn: CompiledFunctionLike): boolean {
    return this.pendingDeopts.has(compiledFn);
  }

  consumeDeopt(compiledFn: CompiledFunctionLike): LazyDeoptInfo | undefined {
    const info = this.pendingDeopts.get(compiledFn);
    this.pendingDeopts.delete(compiledFn);
    return info;
  }

  invalidateDependents(
    reason: string,
    predicate: (compiledFn: CompiledFunctionLike) => boolean,
    allFunctions?: Iterable<CompiledFunctionLike> | null,
  ): number {
    let count = 0;
    if (!allFunctions) return count;
    for (const fn of allFunctions) {
      if (fn.optimizedCode && predicate(fn)) {
        this.markForDeopt(fn, reason);
        count++;
      }
    }
    if (count > 0) {
      tracer.log(
        "deopt",
        `Lazy deopt: marked ${count} functions for deopt (${reason})`,
      );
    }
    return count;
  }

  clear(): void {
    this.pendingDeopts.clear();
  }
}

const IC_FAILURE_REASONS = new Set([
  "map-check-failed",
  "smi-check-failed",
  "number-check-failed",
  "array-check-failed",
  "elements-kind-check-failed",
  "wrong-call-target",
]);

export class Deoptimizer {
  interpreter: InterpreterLike;
  deoptCount: number;
  globalDeoptReasons: Map<string, number>;
  lazyMarker: LazyDeoptMarker;
  materializer: ObjectMaterializer;
  lastDeoptReason?: string;

  constructor(interpreter: InterpreterLike) {
    this.interpreter = interpreter;
    this.deoptCount = 0;
    this.globalDeoptReasons = new Map();
    this.lazyMarker = new LazyDeoptMarker();
    this.materializer = new ObjectMaterializer();
  }

  deoptimize(
    signal: DeoptSignalLike,
    frameStates?: FrameState[] | null,
    args: TaggedValue[] = [],
    thisValue?: TaggedValue,
  ): TaggedValue {
    let frameState: FrameState | null = null;
    if (
      signal.frameStateId !== undefined &&
      signal.frameStateId >= 0 &&
      frameStates
    ) {
      frameState = frameStates[signal.frameStateId];
    }

    this.deoptCount++;
    this.lastDeoptReason = signal.reason;
    this.recordDeoptReason(signal.reason);

    if (frameState) {
      return this.deoptimizeFromFrameState(signal, frameState, args, thisValue);
    } else {
      return this.deoptimizeFromSignalState(signal);
    }
  }

  deoptimizeFromFrameState(
    signal: DeoptSignalLike,
    frameState: FrameState,
    args: TaggedValue[] = [],
    thisValue?: TaggedValue,
  ): TaggedValue {
    const compiledFn = frameState.compiledFunction as CompiledFunctionLike | null;
    const bytecodeOffset = frameState.bytecodeOffset;

    tracer.jitDeopt(
      getFunctionName(compiledFn),
      signal.reason,
      bytecodeOffset,
      deoptOrigin(compiledFn, signal, bytecodeOffset),
    );

    const resolved = withMaterializedAllocations(
      frameState as Parameters<typeof withMaterializedAllocations>[0],
      signal.runtimeValues,
    );
    if (resolved !== signal.runtimeValues && resolved) {
      for (const [id, val] of resolved) signal.runtimeValues.set(id, val);
    }

    const frame = this.materializeFrame(
      requireCompiledFunction(compiledFn, "deoptimizeFromFrameState"),
      frameState,
      signal.runtimeValues,
      signal.closureEnv ?? null,
      args,
      thisValue,
    );

    this.handleDisableOptimization(compiledFn);

    if (frameState.isInlinedFrame && frameState.callerFrameState) {
      tracer.log("deopt", "Cascaded deoptimization: unwinding inline chain");
      return this.resumeCascaded(
        frame,
        frameState,
        signal.runtimeValues,
        signal.closureEnv ?? null,
        args,
        thisValue,
      );
    }

    tracer.jitResume(getFunctionName(compiledFn), bytecodeOffset);
    return this.interpreter.resumeAt(frame);
  }

  deoptimizeFromSignalState(signal: DeoptSignalLike): never {
    const fnName = "<unknown>";
    tracer.jitDeopt(
      fnName,
      signal.reason,
      signal.bytecodeOffset,
      deoptOrigin(null, signal, signal.bytecodeOffset),
    );
    throw new Error(
      `Deoptimization without FrameState not fully supported yet: ${signal.reason}`,
    );
  }

  resumeCascaded(
    innerFrame: RegisterFrame,
    innerFrameState: FrameState,
    runtimeValues: Map<number, TaggedValue>,
    closureEnv: Environment | null,
    args: TaggedValue[] = [],
    thisValue?: TaggedValue,
  ): TaggedValue {
    let currentFs = innerFrameState;

    let finalResult = this.interpreter.resumeAt(innerFrame);

    while (currentFs.callerFrameState) {
      const callerFs = currentFs.callerFrameState;
      const callerFn = callerFs.compiledFunction as CompiledFunctionLike | null;
      const callerFrame = this.materializeFrame(
        requireCompiledFunction(callerFn, "resumeCascaded"),
        callerFs,
        runtimeValues,
        closureEnv,
        args,
        thisValue,
      );

      callerFrame.acc = finalResult;

      this.handleDisableOptimization(callerFn);

      tracer.jitResume(getFunctionName(callerFn), callerFs.bytecodeOffset);
      finalResult = this.interpreter.resumeAt(callerFrame);
      currentFs = callerFs;
    }

    return finalResult;
  }

  handleDisableOptimization(compiledFn: CompiledFunctionLike | null): void {
    if (!compiledFn) return;
    const policy = this.interpreter && this.interpreter.tieringPolicy;
    const maxDeoptCount = policy?.maxDeoptCount ?? MAX_DEOPT_COUNT;
    compiledFn.deoptCount = (compiledFn.deoptCount || 0) + 1;
    dependencyRegistry.unregister(compiledFn as Parameters<typeof dependencyRegistry.unregister>[0]);
    compiledFn.optimizedCode = null;
    updateCallMode(compiledFn);

    const reason = this.lastDeoptReason || "unknown";
    compiledFn.lastDeoptReason = reason;

    if (policy && typeof policy.recordDeopt === "function") {
      policy.recordDeopt(compiledFn, reason);
    }

    if (compiledFn.deoptCount >= maxDeoptCount) {
      compiledFn.disableOptimization = true;
      tracer.jitDeopt(
        getFunctionName(compiledFn),
        `Optimization permanently disabled after ${maxDeoptCount} deoptimizations`,
        -1,
      );
    }
  }

  materializeFrame(
    compiledFn: CompiledFunctionLike,
    frameState: FrameState,
    runtimeValues: Map<number, TaggedValue>,
    closureEnv: Environment | null,
    args: TaggedValue[] = [],
    thisValue?: TaggedValue,
  ): RegisterFrame {
    return materializeFrameFromState(
      compiledFn,
      args,
      thisValue,
      frameState,
      runtimeValues,
      this.interpreter,
      closureEnv,
    );
  }

  materializeValue(
    irNodeOrValue: RuntimeValue,
    runtimeValues: Map<number, TaggedValue>,
    args: TaggedValue[] = [],
    thisValue: TaggedValue | null = null,
  ): TaggedValue {
    return materializeFrameValue(
      irNodeOrValue as Parameters<typeof materializeFrameValue>[0],
      runtimeValues,
      args,
      this.interpreter,
      thisValue,
    );
  }

  recordDeoptReason(reason: string): void {
    const count = this.globalDeoptReasons.get(reason) || 0;
    this.globalDeoptReasons.set(reason, count + 1);
  }

  getStats(): { total: number; reasons: Record<string, number> } {
    const reasons: Record<string, number> = {};
    for (const [r, count] of this.globalDeoptReasons) {
      reasons[r] = count;
    }
    return {
      total: this.deoptCount,
      reasons,
    };
  }
}
