import type { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";
import type { FrameState } from "../deopt/frame-state.js";
import type { AnalysisManager } from "./infra/analysis-manager.js";
import type { CFGFunction } from "./ir/index.js";

export interface CompilationUnit {
  readonly name: string;
  readonly graph: CFGFunction;
  readonly frameStates: readonly FrameState[];
  readonly compiledFunction: RegisterCompiledFunction | null;
  readonly osrOffset: number | null;
  readonly analyses?: AnalysisManager<CFGFunction>;
}

export interface ModuleIR {
  readonly name: string;
  readonly units: readonly CompilationUnit[];
}

export function createCompilationUnit(
  graph: CFGFunction,
  frameStates: readonly FrameState[] = [],
  compiledFunction: RegisterCompiledFunction | null = null,
  osrOffset: number | null = null,
  analyses?: AnalysisManager<CFGFunction>,
): CompilationUnit {
  return {
    name: graph.name,
    graph,
    frameStates,
    compiledFunction,
    osrOffset,
    analyses,
  };
}

export function createModuleIR(
  units: Iterable<CompilationUnit>,
  name = "module",
): ModuleIR {
  return { name, units: [...units] };
}

export function moduleFromGraphs(
  graphs: Iterable<CFGFunction>,
  name = "module",
): ModuleIR {
  return createModuleIR([...graphs].map((graph) => createCompilationUnit(graph)), name);
}
