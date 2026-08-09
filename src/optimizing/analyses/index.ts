import type { CFGFunction } from "../ir/index.js";
import { AnalysisRegistry } from "../infra/analysis-manager.js";
import { dominanceAnalysis } from "./dominance.js";
import { loopForestAnalysis } from "./loops.js";

export function createAnalysisRegistry(): AnalysisRegistry<CFGFunction> {
  const registry = new AnalysisRegistry<CFGFunction>();
  registry.register(dominanceAnalysis);
  registry.register(loopForestAnalysis);
  return registry;
}

export * from "./dominance.js";
export * from "./dominance-core.js";
export * from "./escape.js";
export * from "./loops.js";
