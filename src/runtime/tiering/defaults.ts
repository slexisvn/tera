export const BACK_EDGES_PER_SAFEPOINT = 1024;

export const DEFAULT_TIERING_POLICY = Object.freeze({
  baselineThreshold: 8,
  jitThreshold: 50,
  loopOsrThreshold: 30,
  maxDeoptCount: 3,
  compileCooldownStepMs: 250,
  maxCompileCooldownMs: 5000,
});

export interface CompileCooldown {
  readonly compileCooldownStepMs: number;
  readonly maxCompileCooldownMs: number;
}

export function compileCooldownUntil(
  policy: CompileCooldown,
  failureCount: number,
  now: number,
): number {
  return (
    now + Math.min(policy.maxCompileCooldownMs, policy.compileCooldownStepMs * failureCount)
  );
}
