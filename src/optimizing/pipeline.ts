import type { CFGFunction } from "./ir/index.js";
import { AnalysisManager, type AnalysisId } from "./infra/analysis-manager.js";
import {
  PassManager,
  VerificationError,
  type GraphVerification,
  type Preservation,
  type TransformPass,
} from "./infra/pass-manager.js";
import type { PassTracing } from "./infra/pass-trace.js";
import { cfgGraphProbe } from "./ir/probe.js";
import { compilerOptions, type CompilerOptions } from "./options.js";
import { GraphValidationError, validateGraphInvariants } from "./validation/graph-validator.js";
import { buildFrameStateIndex } from "./ir/frame-state-values.js";
import { homeFloatingValues, reserveNodeIds } from "./ir/graph-edit.js";
import { hoistLoopInvariants, peelLoopChecks } from "./passes/loop-opts.js";
import { loopUnswitching } from "./passes/unswitching.js";
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
    optional: true,
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
  const unswitchBudget = options.deoptimizes ? 0 : options.unswitchBudget;
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
        "loop-unswitching",
        invalidatesAnalyses,
        (g, analyses) =>
          loopUnswitching(g, analyses.get(loopForestAnalysisId), unswitchBudget),
        [loopId],
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
        invalidatesAnalyses,
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
        "loop-check-peeling",
        preservesControlFlow,
        (g, analyses) =>
          peelLoopChecks(
            g,
            analyses.get(loopForestAnalysisId),
            analyses.get(dominanceAnalysisId),
            options.peelBudget,
          ),
        [loopId, dominanceId],
      ),
      step(
        "redundant-checks-after-peeling",
        preservesControlFlow,
        (g, analyses) => eliminateRedundantChecks(g, analyses.get(dominanceAnalysisId)),
        [dominanceId],
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
      step("trivial-phi-elimination-after-unreachable", preservesControlFlow, (g) => eliminateTrivialPhis(g)),
      step("dead-code-elimination-after-unreachable", preservesControlFlow, (g) => deadCodeElimination(g)),
    ]),
  ];
}

export function middleEndPipeline(
  options: CompilerOptions = compilerOptions(),
): TransformPass<CFGFunction>[] {
  return middleEndPhases(options).flatMap((pipelinePhase) => pipelinePhase.passes);
}

export function cfgPassTracing(options: CompilerOptions): PassTracing<CFGFunction> | null {
  if (options.passTracer === null) return null;
  return { probe: cfgGraphProbe, trace: options.passTracer };
}

const BUILT = "it was built";

const verifyAfterPass: GraphVerification<CFGFunction> = (graph, pass) => {
  try {
    validateGraphInvariants(graph);
    return [];
  } catch (error) {
    if (!(error instanceof GraphValidationError)) throw error;
    return error.errors.map((message) => `${graph.name} after ${pass}: ${message}`);
  }
};

export function cfgPassManager(
  analyses: AnalysisManager<CFGFunction>,
  options: CompilerOptions,
): PassManager<CFGFunction> {
  return new PassManager<CFGFunction>(analyses, options, {
    tracing: cfgPassTracing(options),
    maintain: maintainGraph,
    verify: options.verifyEachPass ? verifyAfterPass : null,
  });
}

export const IR_BUILDER_STAGE = "ir-builder";

export function runMiddleEnd(
  graph: CFGFunction,
  options: CompilerOptions = compilerOptions(),
): AnalysisManager<CFGFunction> {
  reserveNodeIds(graph);
  const analyses = new AnalysisManager<CFGFunction>(graph, createAnalysisRegistry());
  if (options.verifyEachPass) {
    const broken = verifyAfterPass(graph, BUILT);
    if (broken.length > 0) throw new VerificationError(broken);
  }
  if (options.passTracer !== null) {
    const nodes = cfgGraphProbe.nodeCount(graph);
    options.passTracer({
      ordinal: -1,
      pass: IR_BUILDER_STAGE,
      changed: true,
      skipped: false,
      elapsedMs: 0,
      nodesBefore: nodes,
      nodesAfter: nodes,
      requires: [],
      invalidated: [],
      remarks: [],
      verification: [],
      graph,
    });
  }
  const passManager = cfgPassManager(analyses, options);
  for (const pipelinePhase of middleEndPhases(options)) {
    passManager.run(graph, pipelinePhase.passes);
  }
  return analyses;
}
