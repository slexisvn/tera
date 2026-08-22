import type { CFGFunction } from "./ir/index.js";
import { AnalysisManager, type AnalysisId } from "./infra/analysis-manager.js";
import {
  PassManager,
  type GraphVerification,
  type Preservation,
  type TransformPass,
} from "./infra/pass-manager.js";
import { consolePassTraceSink, type PassTracer } from "./infra/pass-trace.js";
import { cfgGraphProbe } from "./ir/probe.js";
import { compilerOptions, type CompilerOptions } from "./options.js";
import { GraphValidationError, validateGraphInvariants } from "./validation/graph-validator.js";
import { buildFrameStateIndex } from "./ir/frame-state-values.js";
import { homeFloatingValues } from "./ir/graph-edit.js";
import { hoistLoopInvariants, loopUnrolling } from "./passes/loop-opts.js";
import {
  eliminateRedundantChecks,
  rangeAnalysisAndBoundsCheckElimination,
} from "./passes/checks.js";
import { algebraicSimplification, strengthReduction } from "./passes/simplify.js";
import { sparseConditionalConstantPropagation } from "./passes/sccp.js";
import { escapeAnalysisAndScalarReplacement } from "./passes/escape-analysis.js";
import { allocationSinking } from "./passes/allocation-sinking.js";
import { inlineCacheLowering } from "./passes/ic-lowering.js";
import { lowerBuiltinMethods } from "./passes/builtin-method-lowering.js";
import { globalValueNumbering } from "./passes/gvn.js";
import {
  deadCodeElimination,
  eliminateDeadPhis,
  eliminateTrivialPhis,
  eliminateUnreachableBlocks,
} from "./passes/dce.js";
import { loadElimination } from "./passes/load-elimination.js";
import { deadStoreElimination } from "./passes/dead-stores.js";
import { commonSubexpressionIntrinsicReads } from "./passes/intrinsic-cse.js";
import { typeNarrowing } from "./passes/type-narrowing.js";
import { specializeAllocationShapes } from "./passes/allocation-shape.js";
import { insertDeclaredParameterGuards } from "./passes/parameter-guards.js";
import { dominanceAnalysisId } from "./analyses/dominance.js";
import { loopForestAnalysisId } from "./analyses/loops.js";
import { modRefAnalysisId } from "./analyses/mod-ref.js";
import { pointsToAnalysisId } from "./analyses/points-to.js";
import { typeInferenceAnalysisId } from "./analyses/type-inference.js";
import { createAnalysisRegistry } from "./analyses/index.js";

export type CompilerPipelinePhase =
  | "high-level-optimization"
  | "canonicalization"
  | "late-optimization";

export interface OptimizationPhase<G> {
  readonly name: CompilerPipelinePhase;
  readonly passes: readonly TransformPass<G>[];
}

type PassResult = number | boolean | { readonly changed?: boolean; readonly sunkCount?: number };
type PassApply = (graph: CFGFunction, analyses: AnalysisManager<CFGFunction>) => PassResult;

const dominanceId = dominanceAnalysisId as AnalysisId<unknown>;
const loopId = loopForestAnalysisId as AnalysisId<unknown>;
const pointsToId = pointsToAnalysisId as AnalysisId<unknown>;
const modRefId = modRefAnalysisId as AnalysisId<unknown>;
const typeInferenceId = typeInferenceAnalysisId as AnalysisId<unknown>;
const controlFlowAnalyses: readonly AnalysisId<unknown>[] = [dominanceId, loopId];
const preservesControlFlow: Preservation = { kind: "only", preserved: controlFlowAnalyses };
const invalidatesAnalyses: Preservation = { kind: "none" };

export function maintainGraph(graph: CFGFunction): void {
  homeFloatingValues(graph);
  buildFrameStateIndex(graph);
}

function changed(result: PassResult): boolean {
  if (typeof result === "number") return result > 0;
  if (typeof result === "boolean") return result;
  return result.changed === true || (result.sunkCount ?? 0) > 0;
}

function step(
  name: string,
  preserves: Preservation,
  apply: PassApply,
  requires: readonly AnalysisId<unknown>[] = [],
): TransformPass<CFGFunction> {
  return {
    name,
    preserves,
    requires,
    run: (graph, analyses) => ({ changed: changed(apply(graph, analyses)) }),
  };
}

function phase(
  name: CompilerPipelinePhase,
  passes: readonly TransformPass<CFGFunction>[],
): OptimizationPhase<CFGFunction> {
  return { name, passes };
}

export function middleEndPhases(
  options: CompilerOptions = compilerOptions(),
): OptimizationPhase<CFGFunction>[] {
  const enabledPasses = (on: boolean, passes: readonly TransformPass<CFGFunction>[]) =>
    on ? passes : [];
  const aggregatePasses = (passes: readonly TransformPass<CFGFunction>[]) =>
    enabledPasses(options.scalarReplaceAggregates, passes);
  return [
    phase("high-level-optimization", [
      step(
        "parameter-type-guards",
        preservesControlFlow,
        (g) => insertDeclaredParameterGuards(g),
      ),
      step(
        "allocation-shape",
        preservesControlFlow,
        (g) => specializeAllocationShapes(g),
      ),
      step("ic-lowering", preservesControlFlow, (g) => inlineCacheLowering(g)),
      step("trivial-phi-elimination-early", preservesControlFlow, (g) => eliminateTrivialPhis(g)),
      step(
        "builtin-method-lowering",
        preservesControlFlow,
        (g, analyses) => lowerBuiltinMethods(g, analyses.get(typeInferenceAnalysisId)),
        [typeInferenceId],
      ),
      step(
        "licm",
        preservesControlFlow,
        (g, analyses) =>
          hoistLoopInvariants(
            g,
            analyses.get(loopForestAnalysisId),
            analyses.get(pointsToAnalysisId),
            analyses.get(modRefAnalysisId),
          ),
        [loopId, pointsToId, modRefId],
      ),
      step(
        "redundant-checks",
        preservesControlFlow,
        (g, analyses) => eliminateRedundantChecks(g, analyses.get(dominanceAnalysisId)),
        [dominanceId],
      ),
      step(
        "type-narrowing",
        preservesControlFlow,
        (g, analyses) =>
          typeNarrowing(
            g,
            analyses.get(dominanceAnalysisId),
            analyses.get(typeInferenceAnalysisId),
          ),
        [dominanceId, typeInferenceId],
      ),
    ]),
    phase("canonicalization", [
      step("sccp", invalidatesAnalyses, (g) => sparseConditionalConstantPropagation(g)),
      step("algebraic-simplification", preservesControlFlow, (g) => algebraicSimplification(g)),
      step(
        "load-elimination",
        preservesControlFlow,
        (g, analyses) =>
          loadElimination(
            g,
            analyses.get(pointsToAnalysisId),
            analyses.get(modRefAnalysisId),
          ),
        [pointsToId, modRefId],
      ),
      ...aggregatePasses([
        step(
          "escape-analysis",
          preservesControlFlow,
          (g, analyses) =>
            escapeAnalysisAndScalarReplacement(
              g,
              analyses.get(dominanceAnalysisId),
              analyses.get(pointsToAnalysisId),
            ),
          [dominanceId, pointsToId],
        ),
      ]),
      ...enabledPasses(options.sinkAllocations, [
        step("allocation-sinking", preservesControlFlow, (g) => allocationSinking(g)),
      ]),
      step("sccp-after-escape", invalidatesAnalyses, (g) => sparseConditionalConstantPropagation(g)),
      step("algebraic-simplification-after-escape", preservesControlFlow, (g) => algebraicSimplification(g)),
      step("intrinsic-cse", preservesControlFlow, (g) => commonSubexpressionIntrinsicReads(g)),
      step(
        "gvn",
        preservesControlFlow,
        (g, analyses) => globalValueNumbering(g, analyses.get(dominanceAnalysisId)),
        [dominanceId],
      ),
      step(
        "bounds-check-elimination",
        invalidatesAnalyses,
        (g, analyses) =>
          rangeAnalysisAndBoundsCheckElimination(
            g,
            analyses.get(loopForestAnalysisId),
          ),
        [loopId],
      ),
      step("strength-reduction", preservesControlFlow, (g) => strengthReduction(g)),
      step(
        "loop-unrolling",
        preservesControlFlow,
        (g, analyses) =>
          loopUnrolling(
            g,
            analyses.get(loopForestAnalysisId),
            analyses.get(dominanceAnalysisId),
          ),
        [loopId, dominanceId],
      ),
      step("trivial-phi-elimination", preservesControlFlow, (g) => eliminateTrivialPhis(g)),
      step("dead-phi-elimination", preservesControlFlow, (g) => eliminateDeadPhis(g)),
      ...aggregatePasses([
        step(
          "escape-analysis-late",
          preservesControlFlow,
          (g, analyses) =>
            escapeAnalysisAndScalarReplacement(
              g,
              analyses.get(dominanceAnalysisId),
              analyses.get(pointsToAnalysisId),
            ),
          [dominanceId, pointsToId],
        ),
      ]),
      step("trivial-phi-elimination-after-late-escape", preservesControlFlow, (g) => eliminateTrivialPhis(g)),
      step("dead-phi-elimination-after-late-escape", preservesControlFlow, (g) => eliminateDeadPhis(g)),
      step("dead-code-elimination-after-late-escape", preservesControlFlow, (g) => deadCodeElimination(g)),
    ]),
    phase("late-optimization", [
      step(
        "dead-store-elimination",
        preservesControlFlow,
        (g, analyses) =>
          deadStoreElimination(
            g,
            analyses.get(pointsToAnalysisId),
            analyses.get(modRefAnalysisId),
          ),
        [pointsToId, modRefId],
      ),
      step("dead-code-elimination", preservesControlFlow, (g) => deadCodeElimination(g)),
      step("unreachable-block-elimination", invalidatesAnalyses, (g) => eliminateUnreachableBlocks(g)),
    ]),
  ];
}

export function middleEndPipeline(
  options: CompilerOptions = compilerOptions(),
): TransformPass<CFGFunction>[] {
  return middleEndPhases(options).flatMap((pipelinePhase) => pipelinePhase.passes);
}

export function cfgPassTracer(options: CompilerOptions): PassTracer<CFGFunction> | null {
  if (!options.printAfterAll) return null;
  return { probe: cfgGraphProbe, sink: consolePassTraceSink };
}

const verifyAfterPass: GraphVerification<CFGFunction> = (graph, pass) => {
  try {
    validateGraphInvariants(graph);
  } catch (error) {
    if (!(error instanceof GraphValidationError)) throw error;
    throw new GraphValidationError(
      error.errors.map((message) => `${graph.name} after ${pass}: ${message}`),
    );
  }
};

export function cfgPassManager(
  analyses: AnalysisManager<CFGFunction>,
  options: CompilerOptions,
): PassManager<CFGFunction> {
  return new PassManager<CFGFunction>(analyses, options, {
    tracer: cfgPassTracer(options),
    maintain: maintainGraph,
    verify: options.verifyEachPass ? verifyAfterPass : null,
  });
}

export function runMiddleEnd(
  graph: CFGFunction,
  options: CompilerOptions = compilerOptions(),
): AnalysisManager<CFGFunction> {
  const analyses = new AnalysisManager<CFGFunction>(graph, createAnalysisRegistry());
  const passManager = cfgPassManager(analyses, options);
  for (const pipelinePhase of middleEndPhases(options)) {
    passManager.run(graph, pipelinePhase.passes);
  }
  return analyses;
}
