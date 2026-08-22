export type OptLevel = "none" | "baseline" | "speed" | "max";

export interface CompilerOptions {
  readonly optLevel: OptLevel;
  readonly inlineBudget: number;
  readonly maxInlineDepth: number;
  readonly unrollFactor: number;
  readonly maxInObjectProperties: number;
  readonly scalarReplaceAggregates: boolean;
  readonly sinkAllocations: boolean;
  readonly printAfterAll: boolean;
  readonly verifyEachPass: boolean;
}

type OptLevelPreset = Omit<
  CompilerOptions,
  | "optLevel"
  | "scalarReplaceAggregates"
  | "sinkAllocations"
  | "printAfterAll"
  | "verifyEachPass"
>;

const presets: Record<OptLevel, OptLevelPreset> = {
  none: { inlineBudget: 0, maxInlineDepth: 0, unrollFactor: 1, maxInObjectProperties: 10 },
  baseline: { inlineBudget: 64, maxInlineDepth: 1, unrollFactor: 1, maxInObjectProperties: 10 },
  speed: { inlineBudget: 512, maxInlineDepth: 3, unrollFactor: 4, maxInObjectProperties: 10 },
  max: { inlineBudget: 2048, maxInlineDepth: 5, unrollFactor: 8, maxInObjectProperties: 10 },
};

export function compilerOptions(
  optLevel: OptLevel = "speed",
  overrides: Partial<Omit<CompilerOptions, "optLevel">> = {},
): CompilerOptions {
  return {
    optLevel,
    scalarReplaceAggregates: true,
    sinkAllocations: true,
    printAfterAll: false,
    verifyEachPass: false,
    ...presets[optLevel],
    ...overrides,
  };
}
