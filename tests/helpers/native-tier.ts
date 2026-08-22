const TIERS = { off: 0, native: 1, full: 2 } as const;

export type NativeTier = keyof typeof TIERS;

export const NATIVE_TIER_VARIABLE = "TERA_NATIVE";

function requested(): NativeTier {
  const name = process.env[NATIVE_TIER_VARIABLE];
  return name !== undefined && name in TIERS ? (name as NativeTier) : "off";
}

export const nativeTier = requested();

export const runsOwnBackends = TIERS[nativeTier] >= TIERS.native;
export const runsToolchain = TIERS[nativeTier] >= TIERS.full;
