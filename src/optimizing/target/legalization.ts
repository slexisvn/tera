import type { CFGFunction } from "../ir/index.js";
import type { AnalysisId } from "../infra/analysis-manager.js";
import type { TransformPass } from "../infra/pass-manager.js";
import { dominanceAnalysisId } from "../analyses/dominance.js";
import { loopForestAnalysisId } from "../analyses/loops.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";
import { capabilityCheck } from "../passes/capability-check.js";
import { deadCodeElimination } from "../passes/dce.js";
import { elideFrameStates } from "../passes/frame-state-elision.js";
import { representationSelection } from "../passes/repr-selection.js";
import { speculationLowering } from "../passes/speculation-lowering.js";
import type { TargetModel } from "./model.js";

const preservesControlFlow = {
  kind: "only",
  preserved: [
    dominanceAnalysisId as AnalysisId<unknown>,
    loopForestAnalysisId as AnalysisId<unknown>,
  ],
} as const;

const representationSelectionPass: TransformPass<CFGFunction> = {
  name: "representation-selection",
  preserves: preservesControlFlow,
  run: (graph) => ({ changed: representationSelection(graph) > 0 }),
};

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
    ...(target.capabilities.has("tagged-values") ? [representationSelectionPass] : []),
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
