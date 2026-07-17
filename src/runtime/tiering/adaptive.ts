import { ExecutionProfile } from "../../feedback/profile/index.js";
import { tracer } from "../../core/tracing/index.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";

const DEFAULT_HOTNESS_THRESHOLD = 50;
const COOLDOWN_BASE_MS = 500;
const COOLDOWN_FACTOR = 4;
const MAX_CONSECUTIVE_DEOPTS = 10;
const OSR_URGENCY_MULTIPLIER = 0.1;
const MAX_COMPILE_FAILURES = 4;

type AdaptiveTieringOptions = {
  hotnessThreshold?: number;
  baselineThreshold?: number;
  loopOsrThreshold?: number;
  jitThreshold?: number;
};
type FeedbackSummary = Record<string, number>;
type TieringFunctionRecord = {
  name?: string | null;
  invocationCount?: number;
  optimizedCode?: { _osrEntry?: object } | null;
  baselineCode?: object | null;
  disableOptimization?: boolean;
  optimizationCooldownUntil?: number;
  feedbackVector?: { getSummaryStats(): FeedbackSummary } | null;
};
type TieringProfileKey = TieringFunctionRecord | string | number | boolean | symbol | null | undefined;

export class AdaptiveTieringPolicy {
  profiles: Map<string, ExecutionProfile>;
  objectProfileKeys: WeakMap<object, string>;
  nextProfileKey: number;
  hotnessThreshold: number;
  baselineThreshold: number;
  loopOsrThreshold: number;
  maxDeoptCount: number;
  jitThreshold: number;
  compilationPressure: number;

  constructor(options: AdaptiveTieringOptions | "adaptive" = {}) {
    const opts = options === "adaptive" ? {} : options;
    this.profiles = new Map();
    this.objectProfileKeys = new WeakMap();
    this.nextProfileKey = 1;
    this.hotnessThreshold =
      opts.hotnessThreshold || DEFAULT_HOTNESS_THRESHOLD;
    this.baselineThreshold = opts.baselineThreshold || 10;
    this.loopOsrThreshold = opts.loopOsrThreshold || 30;
    this.maxDeoptCount = Infinity;
    this.jitThreshold = opts.jitThreshold || 50;
    this.compilationPressure = 0;
  }

  getProfile(fn: TieringProfileKey): ExecutionProfile {
    const key = this.getProfileKey(fn);
    if (!this.profiles.has(key)) {
      this.profiles.set(key, new ExecutionProfile());
    }
    return this.profiles.get(key)!;
  }

  getProfileKey(fn: TieringProfileKey): string {
    if (fn === null || fn === undefined || typeof fn !== "object") {
      return `primitive:${String(fn)}`;
    }
    let key = this.objectProfileKeys.get(fn);
    if (!key) {
      key = `fn:${this.nextProfileKey++}`;
      this.objectProfileKeys.set(fn, key);
    }
    return key;
  }

  recordExecution(fn: TieringFunctionRecord, elapsedMs: number): void {
    this.getProfile(fn).recordExecution(elapsedMs);
  }

  recordDeopt(fn: TieringFunctionRecord, reason: string): void {
    const profile = this.getProfile(fn);
    profile.recordDeopt(reason);

    const cooldownMs =
      COOLDOWN_BASE_MS *
      Math.pow(COOLDOWN_FACTOR, Math.min(profile.deoptCount - 1, 5));
    fn.optimizationCooldownUntil = Date.now() + cooldownMs;
    fn.optimizedCode = null;

    tracer.log(
      "TIER",
      `Deopt #${profile.deoptCount} for "${fn.name}" — cooldown ${cooldownMs}ms, reason: ${reason}`,
    );
  }

  recordICTransition(fn: TieringFunctionRecord): void {
    this.getProfile(fn).recordICTransition();
  }

  recordLoopIterations(fn: TieringFunctionRecord, count: number): void {
    if (count > 0) this.getProfile(fn).recordLoopIterations(count);
  }

  recordCompileFailure(fn: TieringFunctionRecord, reason: string): void {
    const profile = this.getProfile(fn);
    profile.compileFailureCount = (profile.compileFailureCount || 0) + 1;
    profile.lastCompileFailureReason = reason;
    profile.lastCompileFailureTime = Date.now();
  }

  recordCompileSuccess(fn: TieringFunctionRecord): void {
    const profile = this.getProfile(fn);
    profile.compileFailureCount = 0;
    profile.lastCompileFailureReason = null;
    profile.lastCompileFailureTime = 0;
  }

  shouldOptimize(fn: TieringFunctionRecord): boolean {
    if (fn.optimizedCode) return false;
    if (fn.disableOptimization) return false;

    const now = Date.now();
    if (fn.optimizationCooldownUntil && now < fn.optimizationCooldownUntil) {
      return false;
    }

    const profile = this.getProfile(fn);

    if ((profile.compileFailureCount || 0) >= MAX_COMPILE_FAILURES) {
      return false;
    }

    if (profile.deoptCount > 0 && !profile.isStable()) {
      return false;
    }

    if (profile.deoptCount > 0 && !hasStableFeedback(fn)) {
      return false;
    }

    if (profile.deoptCount >= MAX_CONSECUTIVE_DEOPTS) {
      const lastReason = profile.deoptReasons[profile.deoptReasons.length - 1];
      const sameReasonCount = profile.deoptReasons.filter(
        (r: string) => r === lastReason,
      ).length;
      if (sameReasonCount >= MAX_CONSECUTIVE_DEOPTS) {
        return false;
      }
    }

    const invocations = fn.invocationCount || 0;
    if (invocations < this.jitThreshold) {
      return false;
    }

    if (!hasStableFeedback(fn)) {
      return false;
    }

    return true;
  }

  shouldBaselineCompile(fn: TieringFunctionRecord): boolean {
    return (
      (fn.invocationCount || 0) >= this.baselineThreshold && !fn.baselineCode
    );
  }

  getOSRUrgency(fn: TieringFunctionRecord, loopCount: number): number {
    const profile = this.getProfile(fn);
    const bodyEstimate = Math.max(
      profile.emaTimeMs * OSR_URGENCY_MULTIPLIER,
      1,
    );
    return loopCount * bodyEstimate;
  }

  shouldOSR(fn: TieringFunctionRecord, loopCount: number): boolean {
    if (!hasOptimizedOSREntry(fn) || fn.disableOptimization) return false;
    if (
      fn.optimizationCooldownUntil &&
      Date.now() < fn.optimizationCooldownUntil
    )
      return false;
    const profile = this.getProfile(fn);
    if ((profile.compileFailureCount || 0) >= MAX_COMPILE_FAILURES)
      return false;
    if (!hasOSRReadyFeedback(fn)) return false;
    return (
      loopCount >= this.loopOsrThreshold &&
      this.getOSRUrgency(fn, loopCount) >= this.loopOsrThreshold
    );
  }

  notifyCompilationStart(): void {
    this.compilationPressure = Math.min(this.compilationPressure + 1, 10);
  }

  notifyCompilationEnd(): void {
    this.compilationPressure = Math.max(this.compilationPressure - 0.5, 0);
  }

  getProfileStats(fn: TieringFunctionRecord): Record<string, string | number | boolean | null> {
    const profile = this.getProfile(fn);
    return {
      totalCalls: profile.totalCalls,
      avgTimeMs: profile.avgTimeMs,
      emaTimeMs: profile.emaTimeMs,
      deoptCount: profile.deoptCount,
      compileFailureCount: profile.compileFailureCount || 0,
      lastCompileFailureReason: profile.lastCompileFailureReason || null,
      isStable: profile.isStable(),
      feedbackStable: hasStableFeedback(fn),
      osrFeedbackReady: hasOSRReadyFeedback(fn),
      osrEntryReady: hasOptimizedOSREntry(fn),
      hotness: profile.hotness(),
      callFrequency: profile.callFrequency,
      loopIterations: profile.loopIterations,
    };
  }
}

function hasUsableFeedback(fn: TieringFunctionRecord): boolean {
  const stats = fn.feedbackVector ? fn.feedbackVector.getSummaryStats() : null;
  if (!stats || stat(stats, "initializedSlots") === 0) return true;
  return stat(stats, "megamorphicSlots") === 0;
}

function hasOSRReadyFeedback(fn: TieringFunctionRecord): boolean {
  const stats = fn.feedbackVector ? fn.feedbackVector.getSummaryStats() : null;
  if (!stats || stat(stats, "initializedSlots") === 0) return false;
  if (stat(stats, "totalRecords") <= 0) return false;
  return stat(stats, "megamorphicSlots") === 0;
}

function hasOptimizedOSREntry(fn: TieringFunctionRecord): boolean {
  return !!(
    fn &&
    fn.optimizedCode &&
    typeof fn.optimizedCode._osrEntry === "function"
  );
}

function hasStableFeedback(fn: TieringFunctionRecord): boolean {
  const stats = fn.feedbackVector ? fn.feedbackVector.getSummaryStats() : null;
  if (!stats || stat(stats, "initializedSlots") === 0) return true;
  if (stat(stats, "megamorphicSlots") > 0) return false;
  return (
    stat(stats, "stableSlots") === stat(stats, "initializedSlots") ||
    stat(stats, "monomorphicSlots") === stat(stats, "initializedSlots")
  );
}

function stat(stats: FeedbackSummary, name: string): number {
  return stats[name] ?? 0;
}
