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
import type { ClassTable } from "./metadata/class-table.js";
import { hasClassReceiver } from "./metadata/class-symbols.js";
import { declaredMemberSignature } from "./metadata/class-table.js";
import { gatheredParameterName, type DeclaredSignature } from "./types/signature.js";
import { DominatorTree } from "./analyses/dominance.js";
import { LoopForest } from "./analyses/loops.js";
import type { AnalysisManager } from "./infra/analysis-manager.js";

type CompiledFunctionLike = RegisterCompiledFunction;
type OptimizedGraph = CFGFunction;
type RequiredCompilerExtension = Required<TeraCompilerExtension>;

export interface StaticCompileRequest {
  readonly classes?: ClassTable | null;
  readonly recoversThrows?: boolean;
  readonly gatheredArguments?: number | null;
  readonly options?: CompilerOptions;
}

export function staticCompilerOptions(
  base: CompilerOptions = compilerOptions("speed"),
): CompilerOptions {
  return { ...base, sinkAllocations: false };
}

function gatheringSignature(
  declared: DeclaredSignature | null,
  gatheredArguments: number | null,
): DeclaredSignature | null {
  if (gatheredArguments === null || declared === null) return declared;
  const gathered = Array.from({ length: gatheredArguments }, (_, at) => at);
  return {
    ...declared,
    params: [...declared.params, ...gathered.map(() => declared.rest?.type ?? null)],
    names: [...(declared.names ?? []), ...gathered.map(gatheredParameterName)],
    variadic: false,
  };
}

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

  compileStatic(
    compiledFn: CompiledFunctionLike,
    request: StaticCompileRequest = {},
  ): SpeculativeCompileResult {
    return this.build(
      compiledFn,
      null,
      null,
      staticCompilerOptions(request.options),
      request.classes ?? null,
      request.recoversThrows ?? false,
      request.gatheredArguments ?? null,
    );
  }

  private build(
    compiledFn: CompiledFunctionLike,
    feedback: FeedbackVector | null,
    osrOffset: number | null,
    options: CompilerOptions = compilerOptions(),
    classes: ClassTable | null = null,
    recoversThrows = false,
    gatheredArguments: number | null = null,
  ): SpeculativeCompileResult {
    this.frameStates = [];

    const functionName = compiledFn.name ?? "<anonymous>";

    tracer.jitCompile(functionName, "Starting speculative compilation");

    let graph: OptimizedGraph = new IRGraph(functionName);
    graph.recoversThrows = recoversThrows;
    graph.isAsync = compiledFn.isAsync === true;
    graph.isGenerator = compiledFn.isGenerator === true;
    graph.gatheredArguments = gatheredArguments;
    graph.classes = classes;
    graph.receiver = classes !== null && hasClassReceiver(compiledFn);
    graph.classOwner = classes === null ? null : compiledFn.classOwnerName ?? null;
    graph.declaredSignature = gatheringSignature(
      declaredMemberSignature(compiledFn, classes, graph.receiver),
      gatheredArguments,
    );

    const parameterCount =
      compiledFn.paramCount + (graph.receiver ? 1 : 0) + (gatheredArguments ?? 0);
    for (let i = 0; i < parameterCount; i++) {
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
