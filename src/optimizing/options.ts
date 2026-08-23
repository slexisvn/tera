export type OptLevel = "none" | "baseline" | "speed" | "max";

export interface CompilerOptions {
  readonly optLevel: OptLevel;
  readonly inlineBudget: number;
  readonly inlineThreshold: number;
  readonly ifConversionBudget: number;
  readonly unswitchBudget: number;
  readonly maxInlineDepth: number;
  readonly unrollFactor: number;
  readonly maxInObjectProperties: number;
  readonly deoptimizes: boolean;
  readonly scalarReplaceAggregates: boolean;
  readonly sinkAllocations: boolean;
  readonly printAfterAll: boolean;
  readonly verifyEachPass: boolean;
}

type OptLevelPreset = Omit<
  CompilerOptions,
  | "optLevel"
  | "deoptimizes"
  | "scalarReplaceAggregates"
  | "sinkAllocations"
  | "printAfterAll"
  | "verifyEachPass"
>;

const presets: Record<OptLevel, OptLevelPreset> = {
  none: { inlineThreshold: 0, unswitchBudget: 0, inlineBudget: 0, ifConversionBudget: 0, maxInlineDepth: 0, unrollFactor: 1, maxInObjectProperties: 10 },
  baseline: { inlineThreshold: 8, unswitchBudget: 0, inlineBudget: 64, ifConversionBudget: 0, maxInlineDepth: 1, unrollFactor: 1, maxInObjectProperties: 10 },
  speed: { inlineThreshold: 24, unswitchBudget: 48, inlineBudget: 512, ifConversionBudget: 2, maxInlineDepth: 3, unrollFactor: 4, maxInObjectProperties: 10 },
  max: { inlineThreshold: 64, unswitchBudget: 96, inlineBudget: 2048, ifConversionBudget: 4, maxInlineDepth: 5, unrollFactor: 8, maxInObjectProperties: 10 },
};

export function compilerOptions(
  optLevel: OptLevel = "speed",
  overrides: Partial<Omit<CompilerOptions, "optLevel">> = {},
): CompilerOptions {
  return {
    optLevel,
    deoptimizes: true,
    scalarReplaceAggregates: true,
    sinkAllocations: true,
    printAfterAll: false,
    verifyEachPass: false,
    ...presets[optLevel],
    ...overrides,
  };
}
