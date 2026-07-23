import { IRGraph, type CFGFunction } from "./ir/index.js";
import { tracer } from "../core/tracing/index.js";
import type { FrameState } from "../deopt/frame-state.js";
import type { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";

import { buildIR } from "./builder/ir-builder.js";
import {
  hoistLoopInvariants,
  findLoops,
  loopUnrolling,
} from "./passes/loop-opts.js";
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
  eliminateUnreachableBlocks,
} from "./passes/dce.js";
import { loadElimination } from "./passes/load-elimination.js";
import { deadStoreElimination } from "./passes/dead-stores.js";
import { typeNarrowing } from "./passes/type-narrowing.js";
import { validateOptimizedGraph } from "./validation/graph-validator.js";
import { buildFrameStateIndex, clearFrameStateIndex } from "./passes/frame-state-values.js";
import { applyOsrTransform, repairFrameStateDominance } from "./passes/osr.js";

type CompiledFunctionLike = RegisterCompiledFunction;
type OptimizedGraph = CFGFunction;

export interface SpeculativeCompileResult {
  graph: OptimizedGraph;
  frameStates: FrameState[];
}

export class SpeculativeOptimizer {
  frameStates: FrameState[];

  constructor() {
    this.frameStates = [];
  }

  compile(
    compiledFn: CompiledFunctionLike,
    osrOffset: number | null = null,
  ): SpeculativeCompileResult {
    const feedback = compiledFn.feedbackVector;
    if (!feedback) {
      throw new Error("Cannot optimize without feedback");
    }

    this.frameStates = [];

    const functionName = compiledFn.name ?? "<anonymous>";

    tracer.jitCompile(functionName, "Starting speculative compilation");

    const graph = new IRGraph(functionName);

    for (let i = 0; i < compiledFn.paramCount; i++) {
      graph.addParameter(i);
    }

    const entryBlock = graph.addBlock();
    buildIR(graph, entryBlock, compiledFn, feedback, this.frameStates);
    if (graph.bailout) return { graph, frameStates: this.frameStates };
    graph.rebuildUses();

    if (
      osrOffset !== null &&
      !applyOsrTransform(graph, osrOffset, compiledFn, this.frameStates)
    ) {
      graph.bailout = `no osr entry at ${osrOffset}`;
      return { graph, frameStates: this.frameStates };
    }

    const findLoopsFn = (g: Parameters<typeof findLoops>[0]) => findLoops(g);

    const rebuildAll = (): void => {
      graph.rebuildUses();
      buildFrameStateIndex(graph);
    };

    buildFrameStateIndex(graph);

    const icLowered = inlineCacheLowering(graph, feedback);
    rebuildAll();
    hoistLoopInvariants(graph, findLoopsFn);
    rebuildAll();
    eliminateRedundantChecks(graph);
    rebuildAll();
    const typeNarrowCount = typeNarrowing(graph);
    rebuildAll();
    let foldCount = constantFolding(graph);
    rebuildAll();
    let propCount = constantPropagation(graph);
    rebuildAll();
    let strengthCount = strengthReduction(graph);
    rebuildAll();
    if (propCount > 0) {
      foldCount += constantFolding(graph);
      rebuildAll();
    }
    const loadElimCount = loadElimination(graph);
    rebuildAll();
    const scalarReplCount = escapeAnalysisAndScalarReplacement(graph);
    rebuildAll();
    const sinkResult = allocationSinking(graph);
    const sunkCount = sinkResult.sunkCount;
    rebuildAll();
    if (scalarReplCount > 0 || sunkCount > 0) {
      foldCount += constantFolding(graph);
      rebuildAll();
      propCount += constantPropagation(graph);
      rebuildAll();
    }
    const gvnCount = globalValueNumbering(graph);
    rebuildAll();
    const boundsElimCount = rangeAnalysisAndBoundsCheckElimination(graph);
    rebuildAll();
    const unrollCount = loopUnrolling(graph, findLoopsFn);
    rebuildAll();
    eliminateDeadPhis(graph);
    rebuildAll();
    const repSelCount = representationSelection(graph);
    rebuildAll();
    const deadStoreCount = deadStoreElimination(graph);
    rebuildAll();
    const dceCount = deadCodeElimination(graph);
    rebuildAll();
    const unreachCount = eliminateUnreachableBlocks(graph);
    rebuildAll();
    clearFrameStateIndex(graph);

    repairFrameStateDominance(graph);

    if (
      foldCount +
        propCount +
        strengthCount +
        dceCount +
        unreachCount +
        scalarReplCount +
        sunkCount +
        gvnCount +
        boundsElimCount +
        repSelCount +
        unrollCount +
        loadElimCount +
        deadStoreCount +
        typeNarrowCount >
      0
    ) {
      tracer.jitCompile(
        functionName,
        `Optimizer: ${foldCount} folded, ${propCount} propagated, ${strengthCount} strength-reduced, ${loadElimCount} loads-eliminated, ${deadStoreCount} dead-stores, ${scalarReplCount} scalar-replaced, ${sunkCount} alloc-sunk, ${gvnCount} GVN-eliminated, ${boundsElimCount} bounds-eliminated, ${unrollCount} loops-unrolled, ${repSelCount} repr-selected, ${typeNarrowCount} type-narrowed, ${dceCount} dead eliminated, ${unreachCount} blocks pruned`,
      );
    }

    tracer.jitCompile(
      functionName,
      `CFG built: ${graph.blocks.length} blocks, ${this.frameStates.length} frame states`,
    );

    validateOptimizedGraph(graph, this.frameStates);

    return { graph, frameStates: this.frameStates };
  }
}
