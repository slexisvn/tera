import { AdaptiveTieringPolicy } from "./adaptive.js";

export const DEFAULT_TIERING_POLICY = Object.freeze({
  baselineThreshold: 8,
  jitThreshold: 50,
  loopOsrThreshold: 30,
  maxDeoptCount: 3,
});

export type TieringPolicyOptions =
  | "adaptive"
  | (Partial<typeof DEFAULT_TIERING_POLICY> & { mode?: "adaptive" | string });

export type TieringPolicy = Readonly<typeof DEFAULT_TIERING_POLICY> | AdaptiveTieringPolicy;

export function createTieringPolicy(overrides: TieringPolicyOptions = {}): TieringPolicy {
  if (
    overrides === "adaptive" ||
    (overrides && overrides.mode === "adaptive")
  ) {
    return new AdaptiveTieringPolicy(overrides);
  }
  return Object.freeze({
    ...DEFAULT_TIERING_POLICY,
    ...overrides,
  });
}
