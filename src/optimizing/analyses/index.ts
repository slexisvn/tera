import type { CFGFunction } from "../ir/index.js";
import { AnalysisRegistry } from "../infra/analysis-manager.js";
import { aotLegalityAnalysis } from "./aot-legality.js";
import { dominanceAnalysis } from "./dominance.js";
import { loopForestAnalysis } from "./loops.js";
import { modRefAnalysis } from "./mod-ref.js";
import { pointsToAnalysis } from "./points-to.js";
import { typeInferenceAnalysis } from "./type-inference.js";

export function createAnalysisRegistry(): AnalysisRegistry<CFGFunction> {
  const registry = new AnalysisRegistry<CFGFunction>();
  registry.register(aotLegalityAnalysis);
  registry.register(dominanceAnalysis);
  registry.register(loopForestAnalysis);
  registry.register(pointsToAnalysis);
  registry.register(modRefAnalysis);
  registry.register(typeInferenceAnalysis);
  return registry;
}

export * from "./aot-legality.js";
export * from "./dominance.js";
export * from "./dominance-core.js";
export * from "./heap-model.js";
export * from "./loops.js";
export * from "./mod-ref.js";
export * from "./points-to.js";
export * from "./type-inference.js";
