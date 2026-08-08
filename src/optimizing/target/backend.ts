import type { CFGFunction } from "../ir/index.js";
import type { AnalysisManager } from "../infra/analysis-manager.js";
import type { TransformPass } from "../infra/pass-manager.js";
import type { CompilerOptions } from "../options.js";
import type { TargetModel } from "./model.js";
import type { Emitter } from "./emitter.js";

export type ExecutionMode = "jit" | "aot";

export interface CodeBackend {
  readonly id: string;
  readonly mode: ExecutionMode;
  readonly target: TargetModel;
}

export interface AotBackend extends CodeBackend {
  readonly mode: "aot";
  loweringPipeline(options: CompilerOptions): ReadonlyArray<TransformPass<CFGFunction>>;
  createEmitter(graph: CFGFunction, analyses: AnalysisManager<CFGFunction>): Emitter;
}

export function isAotBackend(backend: CodeBackend): backend is AotBackend {
  return backend.mode === "aot";
}
