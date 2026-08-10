import type { CFGFunction } from "../ir/index.js";
import type { AnalysisId } from "../infra/analysis-manager.js";
import type { TransformPass } from "../infra/pass-manager.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";
import { capabilityCheck } from "../passes/capability-check.js";
import { deadCodeElimination } from "../passes/dce.js";
import { elideFrameStates } from "../passes/frame-state-elision.js";
import { speculationLowering } from "../passes/speculation-lowering.js";
import type { TargetModel } from "./model.js";

export function targetLegalizationPipeline(
  target: TargetModel,
): ReadonlyArray<TransformPass<CFGFunction>> {
  return [
    {
      name: "speculation-lowering",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed:
          speculationLowering(graph, target, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "frame-state-elision",
      preserves: { kind: "all" },
      run: (graph) => ({ changed: elideFrameStates(graph, target) > 0 }),
    },
    {
      name: "dead-code-elimination",
      preserves: { kind: "none" },
      run: (graph) => ({ changed: deadCodeElimination(graph) > 0 }),
    },
    {
      name: "capability-check",
      preserves: { kind: "all" },
      run: (graph) => {
        capabilityCheck(graph, target);
        return { changed: false };
      },
    },
  ];
}
