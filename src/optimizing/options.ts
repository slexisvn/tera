import type { CFGFunction } from "./ir/index.js";
import type { PassTracer } from "./infra/pass-trace.js";
import type { MachineTracer } from "./machine/trace.js";
import type { ModuleTracer } from "./drivers/module-trace.js";

export type OptLevel = "none" | "baseline" | "speed" | "max";

export interface GraphInliningPolicy {
  readonly budget: number;
  readonly maxCalleeSize: number;
  readonly maxLoopingCalleeSize: number;
  readonly minCallFrequency: number;
  readonly maxDepth: number;
}

export interface CompilerOptions {
  readonly optLevel: OptLevel;
  readonly inlineBudget: number;
  readonly inlineThreshold: number;
  readonly graphInlining: GraphInliningPolicy;
  readonly ifConversionBudget: number;
  readonly unswitchBudget: number;
  readonly peelBudget: number;
  readonly deoptimizes: boolean;
  readonly splitLiveRanges: boolean;
  readonly scalarReplaceAggregates: boolean;
  readonly sinkAllocations: boolean;
  readonly passTracer: PassTracer<CFGFunction> | null;
  readonly machineTracer: MachineTracer | null;
  readonly moduleTracer: ModuleTracer | null;
  readonly verifyEachPass: boolean;
}

type OptLevelPreset = Omit<
  CompilerOptions,
  | "optLevel"
  | "deoptimizes"
  | "splitLiveRanges"
  | "scalarReplaceAggregates"
  | "sinkAllocations"
  | "passTracer"
  | "machineTracer"
  | "moduleTracer"
  | "verifyEachPass"
>;

const presets: Record<OptLevel, OptLevelPreset> = {
  none: {
    inlineThreshold: 0,
    inlineBudget: 0,
    unswitchBudget: 0,
    ifConversionBudget: 0,
    peelBudget: 0,
    graphInlining: {
      budget: 0,
      maxCalleeSize: 0,
      maxLoopingCalleeSize: 0,
      minCallFrequency: 5,
      maxDepth: 0,
    },
  },
  baseline: {
    inlineThreshold: 8,
    inlineBudget: 64,
    unswitchBudget: 0,
    ifConversionBudget: 0,
    peelBudget: 20,
    graphInlining: {
      budget: 100,
      maxCalleeSize: 40,
      maxLoopingCalleeSize: 20,
      minCallFrequency: 5,
      maxDepth: 1,
    },
  },
  speed: {
    inlineThreshold: 24,
    inlineBudget: 512,
    unswitchBudget: 48,
    ifConversionBudget: 2,
    peelBudget: 80,
    graphInlining: {
      budget: 400,
      maxCalleeSize: 150,
      maxLoopingCalleeSize: 80,
      minCallFrequency: 5,
      maxDepth: 3,
    },
  },
  max: {
    inlineThreshold: 64,
    inlineBudget: 2048,
    unswitchBudget: 96,
    ifConversionBudget: 4,
    peelBudget: 160,
    graphInlining: {
      budget: 1600,
      maxCalleeSize: 400,
      maxLoopingCalleeSize: 200,
      minCallFrequency: 2,
      maxDepth: 5,
    },
  },
};

export function compilerOptions(
  optLevel: OptLevel = "speed",
  overrides: Partial<Omit<CompilerOptions, "optLevel">> = {},
): CompilerOptions {
  return {
    optLevel,
    deoptimizes: true,
    splitLiveRanges: false,
    scalarReplaceAggregates: true,
    sinkAllocations: true,
    passTracer: null,
    machineTracer: null,
    moduleTracer: null,
    verifyEachPass: false,
    ...presets[optLevel],
    ...overrides,
  };
}

export const DEFAULT_COMPILER_OPTIONS: CompilerOptions = compilerOptions();
