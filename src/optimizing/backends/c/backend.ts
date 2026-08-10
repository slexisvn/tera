import type { CFGFunction } from "../../ir/index.js";
import type { AotBackend } from "../../target/backend.js";
import type { Emitter } from "../../target/emitter.js";
import type { AnalysisManager } from "../../infra/analysis-manager.js";
import { typeInferenceAnalysisId } from "../../analyses/type-inference.js";
import { cTarget } from "./target.js";
import { targetLegalizationPipeline } from "../../target/legalization.js";
import { emitNumericFunction } from "./emit.js";

export class CBackendEmitError extends Error {
  constructor(reason: string) {
    super(`C backend cannot emit: ${reason}`);
    this.name = "CBackendEmitError";
  }
}

export const cBackend: AotBackend = {
  id: "c",
  mode: "aot",
  target: cTarget,
  loweringPipeline: () => targetLegalizationPipeline(cTarget),
  createEmitter(graph: CFGFunction, analyses: AnalysisManager<CFGFunction>): Emitter {
    return {
      emit: () => {
        const result = emitNumericFunction(graph, analyses.get(typeInferenceAnalysisId));
        if (!result.ok) throw new CBackendEmitError(result.reason);
        return {
          kind: "c",
          symbol: result.symbol,
          prototype: result.prototype,
          source: result.source,
          headerPreamble: result.headerPreamble,
          sourcePreamble: result.sourcePreamble,
          translationUnitPreamble: result.translationUnitPreamble,
          references: result.references,
        };
      },
    };
  },
};
