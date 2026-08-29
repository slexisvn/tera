type Optimizable = {
  readonly optimizedCode?: unknown;
  readonly disableOptimization?: unknown;
};

export const HOT_TIERING = { jitThreshold: 2, baselineThreshold: 1, loopOsrThreshold: 2 };

export const FORCED_TIERING = {
  ...HOT_TIERING,
  shouldOptimize: (compiled: Optimizable) =>
    !compiled.optimizedCode && !compiled.disableOptimization,
};

export const COLD_TIERING = {
  jitThreshold: Number.POSITIVE_INFINITY,
  baselineThreshold: Number.POSITIVE_INFINITY,
  loopOsrThreshold: Number.POSITIVE_INFINITY,
};

export const BASELINE_TIERING = {
  baselineThreshold: 1,
  jitThreshold: Number.POSITIVE_INFINITY,
  loopOsrThreshold: Number.POSITIVE_INFINITY,
};

export const TRACED_CATEGORIES = ["jit", "deopt", "ic", "feedback", "hidden_class", "gc", "wasm"];

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
