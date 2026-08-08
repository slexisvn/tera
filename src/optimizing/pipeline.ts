import type { CFGFunction } from "./ir/index.js";
import { AnalysisManager, AnalysisRegistry } from "./infra/analysis-manager.js";
import { PassManager, type TransformPass } from "./infra/pass-manager.js";
import { compilerOptions, type CompilerOptions } from "./options.js";
import { buildFrameStateIndex } from "./passes/frame-state-values.js";
import { hoistLoopInvariants, findLoops, loopUnrolling } from "./passes/loop-opts.js";
import {
  eliminateRedundantChecks,
  rangeAnalysisAndBoundsCheckElimination,
} from "./passes/checks.js";
import {
  constantFolding,
  constantPropagation,
  strengthReduction,
} from "./passes/simplify.js";
import { escapeAnalysisAndScalarReplacement } from "./passes/escape-analysis.js";
import { allocationSinking } from "./passes/allocation-sinking.js";
import { inlineCacheLowering } from "./passes/ic-lowering.js";
import { globalValueNumbering } from "./passes/gvn.js";
import { representationSelection } from "./passes/repr-selection.js";
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

export interface MiddleEndDeps {
  feedback: Parameters<typeof inlineCacheLowering>[1];
  findLoops: typeof findLoops;
}

const maintenance: TransformPass<CFGFunction> = {
  name: "maintenance",
  preserves: { kind: "all" },
  run: (graph) => {
    graph.rebuildUses();
    buildFrameStateIndex(graph);
    return { changed: false };
  },
};

type PassResult = number | boolean | { readonly changed?: boolean; readonly sunkCount?: number };

function changed(result: PassResult): boolean {
  if (typeof result === "number") return result > 0;
  if (typeof result === "boolean") return result;
  return result.changed === true || (result.sunkCount ?? 0) > 0;
}

function step(
  name: string,
  apply: (graph: CFGFunction) => PassResult,
): TransformPass<CFGFunction> {
  return {
    name,
    preserves: { kind: "none" },
    run: (graph) => {
      return { changed: changed(apply(graph)) };
    },
  };
}

function interleave(
  passes: ReadonlyArray<TransformPass<CFGFunction>>,
  separator: TransformPass<CFGFunction>,
): TransformPass<CFGFunction>[] {
  const result: TransformPass<CFGFunction>[] = [];
  for (const pass of passes) {
    result.push(pass, separator);
  }
  return result;
}

export function middleEndPipeline(deps: MiddleEndDeps): TransformPass<CFGFunction>[] {
  const loopsOf = (graph: Parameters<typeof findLoops>[0]) => deps.findLoops(graph);
  const passes: TransformPass<CFGFunction>[] = [
    step("allocation-shape", (g) => specializeAllocationShapes(g)),
    step("ic-lowering", (g) => inlineCacheLowering(g, deps.feedback)),
    step("licm", (g) => hoistLoopInvariants(g, loopsOf)),
    step("redundant-checks", (g) => eliminateRedundantChecks(g)),
    step("type-narrowing", (g) => typeNarrowing(g)),
    step("const-fold-early", (g) => constantFolding(g)),
    step("const-prop-early", (g) => constantPropagation(g)),
    step("const-fold-after-prop", (g) => constantFolding(g)),
    step("load-elimination", (g) => loadElimination(g)),
    step("escape-analysis", (g) => escapeAnalysisAndScalarReplacement(g)),
    step("allocation-sinking", (g) => allocationSinking(g)),
    step("const-fold-after-escape", (g) => constantFolding(g)),
    step("const-prop-after-escape", (g) => constantPropagation(g)),
    step("intrinsic-cse", (g) => commonSubexpressionIntrinsicReads(g)),
    step("gvn", (g) => globalValueNumbering(g)),
    step("bounds-check-elimination", (g) => rangeAnalysisAndBoundsCheckElimination(g)),
    step("strength-reduction", (g) => strengthReduction(g)),
    step("loop-unrolling", (g) => loopUnrolling(g, loopsOf)),
    step("trivial-phi-elimination", (g) => eliminateTrivialPhis(g)),
    step("dead-phi-elimination", (g) => eliminateDeadPhis(g)),
    step("representation-selection", (g) => representationSelection(g)),
    step("dead-store-elimination", (g) => deadStoreElimination(g)),
    step("dead-code-elimination", (g) => deadCodeElimination(g)),
    step("unreachable-block-elimination", (g) => eliminateUnreachableBlocks(g)),
  ];
  return interleave(passes, maintenance);
}

export function runMiddleEnd(
  graph: CFGFunction,
  deps: MiddleEndDeps,
  options: CompilerOptions = compilerOptions(),
): void {
  const analyses = new AnalysisManager<CFGFunction>(graph, new AnalysisRegistry<CFGFunction>());
  new PassManager<CFGFunction>(analyses, options).run(graph, middleEndPipeline(deps));
}
