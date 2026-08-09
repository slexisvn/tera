import type { CFGFunction } from "../../ir/index.js";
import type { AotBackend } from "../../target/backend.js";
import type { Emitter } from "../../target/emitter.js";
import type { TransformPass } from "../../infra/pass-manager.js";
import type { AnalysisId, AnalysisManager } from "../../infra/analysis-manager.js";
import { typeInferenceAnalysisId } from "../../analyses/type-inference.js";
import { speculationLowering } from "../../passes/speculation-lowering.js";
import { capabilityCheck } from "../../passes/capability-check.js";
import { deadCodeElimination } from "../../passes/dce.js";
import { elideFrameStates } from "../../passes/frame-state-elision.js";
import { cTarget } from "./target.js";
import { emitNumericFunction } from "./emit.js";

export class CBackendEmitError extends Error {
  constructor(reason: string) {
    super(`C backend cannot emit: ${reason}`);
    this.name = "CBackendEmitError";
  }
}

const speculationLoweringPass: TransformPass<CFGFunction> = {
  name: "speculation-lowering",
  preserves: { kind: "none" },
  requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
  run: (graph, analyses) => ({
    changed:
      speculationLowering(graph, cTarget, analyses.get(typeInferenceAnalysisId)) > 0,
  }),
};

const frameStateElisionPass: TransformPass<CFGFunction> = {
  name: "frame-state-elision",
  preserves: { kind: "all" },
  run: (graph) => ({ changed: elideFrameStates(graph, cTarget) > 0 }),
};

const deadCodeEliminationPass: TransformPass<CFGFunction> = {
  name: "dead-code-elimination",
  preserves: { kind: "none" },
  run: (graph) => ({ changed: deadCodeElimination(graph) > 0 }),
};

const capabilityCheckPass: TransformPass<CFGFunction> = {
  name: "capability-check",
  preserves: { kind: "all" },
  run: (graph) => {
    capabilityCheck(graph, cTarget);
    return { changed: false };
  },
};

export const cBackend: AotBackend = {
  id: "c",
  mode: "aot",
  target: cTarget,
  loweringPipeline: () => [
    speculationLoweringPass,
    frameStateElisionPass,
    deadCodeEliminationPass,
    capabilityCheckPass,
  ],
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
