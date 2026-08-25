export const BACK_EDGES_PER_SAFEPOINT = 1024;

export interface TieringThresholds {
  readonly baselineThreshold: number;
  readonly jitThreshold: number;
  readonly loopOsrThreshold: number;
  readonly maxDeoptCount: number;
  readonly feedbackSettleMs: number;
  readonly compileCooldownStepMs: number;
  readonly maxCompileCooldownMs: number;
}

export const DEFAULT_TIERING_POLICY: TieringThresholds = Object.freeze({
  baselineThreshold: 8,
  jitThreshold: 50,
  loopOsrThreshold: 30,
  maxDeoptCount: 3,
  feedbackSettleMs: 100,
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
