import type { CFGFunction } from "../ir/index.js";
import type { AnalysisManager } from "../infra/analysis-manager.js";
import type { TransformPass } from "../infra/pass-manager.js";
import type { CompilerOptions } from "../options.js";
import type { TargetModel } from "./model.js";
import type { Emitter } from "./emitter.js";
import type {
  AotLinkOptions,
  AotOutputFile,
  AotOutputFormat,
  EmittedFunction,
} from "./artifact.js";

export type ExecutionMode = "jit" | "aot";

export interface CodeBackend {
  readonly id: string;
  readonly mode: ExecutionMode;
  readonly target: TargetModel;
  loweringPipeline(options: CompilerOptions): ReadonlyArray<TransformPass<CFGFunction>>;
}

export interface LinkableFunction {
  readonly name: string;
  readonly emitted: EmittedFunction;
}

export interface TargetPlatform {
  readonly os: string;
  readonly arch: string;
}

export interface AotBackend extends CodeBackend {
  readonly mode: "aot";
  readonly outputs: readonly AotOutputFormat[];
  readonly platform: TargetPlatform | null;
  readonly emits: ReadonlySet<string>;
  symbolOf(name: string): string;
  createEmitter(
    graph: CFGFunction,
    analyses: AnalysisManager<CFGFunction>,
    options: CompilerOptions,
  ): Emitter;
  link(
    functions: readonly LinkableFunction[],
    options: AotLinkOptions,
  ): readonly AotOutputFile[];
}

export function isAotBackend(backend: CodeBackend): backend is AotBackend {
  return backend.mode === "aot";
}
