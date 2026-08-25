import { AdaptiveTieringPolicy } from "./adaptive.js";
import { DEFAULT_TIERING_POLICY } from "./defaults.js";

export { DEFAULT_TIERING_POLICY, compileCooldownUntil } from "./defaults.js";
export type { TieringThresholds } from "./defaults.js";

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
