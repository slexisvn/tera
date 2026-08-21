import type { CFGFunction } from "../ir/index.js";
import type { AnalysisId, AnalysisManager } from "../infra/analysis-manager.js";
import type { TransformPass } from "../infra/pass-manager.js";
import { dominanceAnalysisId } from "../analyses/dominance.js";
import { loopForestAnalysisId } from "../analyses/loops.js";
import { typeInferenceAnalysisId } from "../analyses/type-inference.js";
import {
  lowerArrayAccess,
  shapeArrayAllocations,
  stampElementTypes,
} from "../passes/array-shapes.js";
import { lowerArrayMethods } from "../passes/array-methods.js";
import { lowerBooleanText } from "../passes/boolean-text.js";
import { expandAggregatePrints } from "../passes/print-expansion.js";
import { lowerBuiltinMethods } from "../passes/builtin-method-lowering.js";
import {
  lowerClassMembers,
  resolveCalleeSignatures,
} from "../passes/class-member-lowering.js";
import { capabilityCheck } from "../passes/capability-check.js";
import { deadCodeElimination } from "../passes/dce.js";
import { elideFrameStates } from "../passes/frame-state-elision.js";
import { lowerGlobalBuiltins } from "../passes/global-builtin-lowering.js";
import { lowerCollectionSurface } from "../passes/collection-surface.js";
import { lowerJsonSurface } from "../passes/json-surface.js";
import { lowerMathSurface } from "../passes/math-surface.js";
import { lowerGlobalVariables } from "../passes/global-variable-lowering.js";
import { lowerStringSplit } from "../passes/string-split.js";
import { lowerIterators } from "../passes/iterator-lowering.js";
import { lowerNamedArguments } from "../passes/named-argument-lowering.js";
import { shapeObjectLiterals } from "../passes/object-literal-shapes.js";
import { lowerObjectSurface } from "../passes/object-surface.js";
import { lowerGeneratorIteration } from "../passes/generator-iteration.js";
import { boxEscapingStrings } from "../passes/string-boxing.js";
import { representationSelection } from "../passes/repr-selection.js";
import { speculationLowering } from "../passes/speculation-lowering.js";
import { typeNarrowing } from "../passes/type-narrowing.js";
import { coerceStringOperands } from "../passes/string-coercion.js";
import { faultOnZeroDivisor } from "../passes/zero-divisor.js";
import { faultOutsideBuiltinDomains } from "../passes/builtin-domains.js";
import { validateRepresentations } from "../validation/graph-validator.js";
import type { TargetModel } from "./model.js";

const preservesControlFlow = {
  kind: "only",
  preserved: [
    dominanceAnalysisId as AnalysisId<unknown>,
    loopForestAnalysisId as AnalysisId<unknown>,
  ],
} as const;

function lowerHeapIteration(
  graph: CFGFunction,
  analyses: AnalysisManager<CFGFunction>,
): boolean {
  let changed = false;
  for (;;) {
    const stamped = stampElementTypes(graph, analyses.get(typeInferenceAnalysisId));
    if (stamped > 0) analyses.invalidate(typeInferenceAnalysisId);
    const lowered = lowerIterators(graph, analyses.get(typeInferenceAnalysisId));
    if (lowered > 0) analyses.invalidate(typeInferenceAnalysisId);
    if (stamped + lowered === 0) return changed;
    changed = true;
  }
}

const representationSelectionPass: TransformPass<CFGFunction> = {
  name: "representation-selection",
  preserves: preservesControlFlow,
  run: (graph) => ({ changed: representationSelection(graph) > 0 }),
};

const representationCheckPass: TransformPass<CFGFunction> = {
  name: "representation-check",
  preserves: { kind: "all" },
  run: (graph) => {
    validateRepresentations(graph);
    return { changed: false };
  },
};

export function targetLegalizationPipeline(
  target: TargetModel,
): ReadonlyArray<TransformPass<CFGFunction>> {
  const tagged = target.capabilities.has("tagged-values");
  return [
    {
      name: "type-narrowing",
      preserves: preservesControlFlow,
      requires: [
        dominanceAnalysisId as AnalysisId<unknown>,
        typeInferenceAnalysisId as AnalysisId<unknown>,
      ],
      run: (graph, analyses) => ({
        changed:
          typeNarrowing(
            graph,
            analyses.get(dominanceAnalysisId),
            analyses.get(typeInferenceAnalysisId),
          ) > 0,
      }),
    },
    ...(tagged
      ? []
      : [
          {
            name: "zero-divisor",
            preserves: { kind: "none" },
            run: (graph: CFGFunction) => ({ changed: faultOnZeroDivisor(graph) > 0 }),
          } as TransformPass<CFGFunction>,
        ]),
    {
      name: "iterator-lowering",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerIterators(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "collection-surface",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerCollectionSurface(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "math-surface",
      preserves: preservesControlFlow,
      run: (graph) => ({ changed: lowerMathSurface(graph) > 0 }),
    },
    {
      name: "global-builtin-lowering",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerGlobalBuiltins(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
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
      name: "object-literal-shapes",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: shapeObjectLiterals(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "object-surface",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerObjectSurface(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "generator-iteration",
      preserves: preservesControlFlow,
      run: (graph) => ({ changed: lowerGeneratorIteration(graph) > 0 }),
    },
    {
      name: "callee-signatures",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: resolveCalleeSignatures(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "array-allocation-shapes",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: shapeArrayAllocations(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "global-variable-lowering",
      preserves: preservesControlFlow,
      run: (graph) => ({ changed: lowerGlobalVariables(graph) > 0 }),
    },
    {
      name: "class-member-lowering",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerClassMembers(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "json-surface",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerJsonSurface(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "string-split-lowering",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerStringSplit(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "heap-iteration",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({ changed: lowerHeapIteration(graph, analyses) }),
    },
    {
      name: "array-method-lowering",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerArrayMethods(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "builtin-method-lowering",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerBuiltinMethods(graph, analyses.get(typeInferenceAnalysisId), target) > 0,
      }),
    },
    ...(tagged
      ? []
      : [
          {
            name: "builtin-domains",
            preserves: { kind: "none" },
            run: (graph: CFGFunction) => ({
              changed: faultOutsideBuiltinDomains(graph) > 0,
            }),
          } as TransformPass<CFGFunction>,
        ]),
    {
      name: "array-access-lowering",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerArrayAccess(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "print-expansion",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: expandAggregatePrints(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "boolean-text",
      preserves: { kind: "none" },
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: lowerBooleanText(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "string-coercion",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: coerceStringOperands(graph, analyses.get(typeInferenceAnalysisId)) > 0,
      }),
    },
    {
      name: "named-argument-lowering",
      preserves: preservesControlFlow,
      run: (graph) => ({ changed: lowerNamedArguments(graph) > 0 }),
    },
    ...(tagged ? [representationSelectionPass, representationCheckPass] : []),
    {
      name: "string-boxing",
      preserves: preservesControlFlow,
      requires: [typeInferenceAnalysisId as AnalysisId<unknown>],
      run: (graph, analyses) => ({
        changed: boxEscapingStrings(graph, analyses.get(typeInferenceAnalysisId)) > 0,
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
