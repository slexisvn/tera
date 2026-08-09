import { IRGraph, type CFGFunction } from "./ir/index.js";
import { tracer } from "../core/tracing/index.js";
import type { FrameState } from "../deopt/frame-state.js";
import type { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";
import type { FeedbackVector } from "../feedback/vector/index.js";
import { createCompilationUnit, type CompilationUnit } from "./compilation-unit.js";

import { buildIR } from "./builder/ir-builder.js";
import type { TeraCompilerExtension, TeraCompilerPhase } from "../api/extensions.js";
import { createIntrinsicOptimizationMetadata, type IntrinsicOptimizationMetadata } from "./metadata/intrinsics.js";
import { validateOptimizedGraph } from "./validation/graph-validator.js";
import { buildFrameStateIndex, clearFrameStateIndex } from "./ir/frame-state-values.js";
import { applyOsrTransform, repairFrameStateDominance } from "./passes/osr.js";
import { runMiddleEnd } from "./pipeline.js";
import { compilerOptions, type CompilerOptions } from "./options.js";
import { DominatorTree } from "./analyses/dominance.js";
import { LoopForest } from "./analyses/loops.js";
import type { AnalysisManager } from "./infra/analysis-manager.js";

type CompiledFunctionLike = RegisterCompiledFunction;
type OptimizedGraph = CFGFunction;
type RequiredCompilerExtension = Required<TeraCompilerExtension>;

const STATIC_OPTIONS = compilerOptions("speed", { scalarReplaceAggregates: false });

export interface SpeculativeCompileResult {
  graph: OptimizedGraph;
  frameStates: FrameState[];
  unit: CompilationUnit;
}

export class Optimizer {
  frameStates: FrameState[];
  private compilerExtensions: RequiredCompilerExtension;
  private intrinsicMetadata: IntrinsicOptimizationMetadata;

  constructor(compilerExtensions: RequiredCompilerExtension = emptyCompilerExtensions()) {
    this.frameStates = [];
    this.compilerExtensions = compilerExtensions;
    this.intrinsicMetadata = createIntrinsicOptimizationMetadata(compilerExtensions);
  }

  setCompilerExtensions(compilerExtensions: RequiredCompilerExtension): void {
    this.compilerExtensions = compilerExtensions;
    this.intrinsicMetadata = createIntrinsicOptimizationMetadata(compilerExtensions);
  }

  private runCompilerPasses<T>(phase: TeraCompilerPhase, target: T): T {
    let current: unknown = target;
    const context = {
      phase,
      intrinsics: this.compilerExtensions.intrinsics,
      effects: this.compilerExtensions.effects,
      guards: this.compilerExtensions.guards,
      deopts: this.compilerExtensions.deopts,
    };
    for (const pass of this.compilerExtensions.optimizerPasses) {
      if (pass.phase !== phase) continue;
      const next = pass.run(current, context);
      if (next !== undefined) current = next;
    }
    return current as T;
  }

  compile(
    compiledFn: CompiledFunctionLike,
    osrOffset: number | null = null,
  ): SpeculativeCompileResult {
    const feedback = compiledFn.feedbackVector;
    if (!feedback) {
      throw new Error("Cannot optimize without feedback");
    }
    return this.build(compiledFn, feedback, osrOffset);
  }

  compileStatic(compiledFn: CompiledFunctionLike): SpeculativeCompileResult {
    return this.build(compiledFn, null, null, STATIC_OPTIONS);
  }

  private build(
    compiledFn: CompiledFunctionLike,
    feedback: FeedbackVector | null,
    osrOffset: number | null,
    options: CompilerOptions = compilerOptions(),
  ): SpeculativeCompileResult {
    this.frameStates = [];

    const functionName = compiledFn.name ?? "<anonymous>";

    tracer.jitCompile(functionName, "Starting speculative compilation");

    let graph: OptimizedGraph = new IRGraph(functionName);
    graph.declaredSignature = compiledFn.declaredSignature;

    for (let i = 0; i < compiledFn.paramCount; i++) {
      graph.addParameter(i);
    }

    const entryBlock = graph.addBlock();
    buildIR(graph, entryBlock, compiledFn, feedback, this.frameStates, this.intrinsicMetadata);
    if (graph.bailout) return this.resultFor(graph, compiledFn, osrOffset);
    graph.rebuildUses();
    graph = this.runCompilerPasses("ir", graph);
    graph.rebuildUses();

    if (
      osrOffset !== null &&
      !applyOsrTransform(
        graph,
        osrOffset,
        compiledFn,
        this.frameStates,
        new LoopForest(graph, new DominatorTree(graph)),
      )
    ) {
      graph.bailout = `no osr entry at ${osrOffset}`;
      return this.resultFor(graph, compiledFn, osrOffset);
    }

    buildFrameStateIndex(graph);

    const analyses = runMiddleEnd(graph, options);

    clearFrameStateIndex(graph);

    repairFrameStateDominance(graph);

    tracer.jitCompile(
      functionName,
      `CFG built: ${graph.blocks.length} blocks, ${this.frameStates.length} frame states`,
    );

    validateOptimizedGraph(graph, this.frameStates);

    return this.resultFor(graph, compiledFn, osrOffset, analyses);
  }

  private resultFor(
    graph: OptimizedGraph,
    compiledFn: CompiledFunctionLike,
    osrOffset: number | null,
    analyses?: AnalysisManager<CFGFunction>,
  ): SpeculativeCompileResult {
    return {
      graph,
      frameStates: this.frameStates,
      unit: createCompilationUnit(
        graph,
        this.frameStates,
        compiledFn,
        osrOffset,
        analyses,
      ),
    };
  }
}

function emptyCompilerExtensions(): RequiredCompilerExtension {
  return {
    intrinsics: [],
    effects: [],
    guards: [],
    deopts: [],
    optimizerPasses: [],
  };
}
