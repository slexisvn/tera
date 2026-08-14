import type { CFGFunction } from "../../ir/index.js";
import { AnalysisManager } from "../../infra/analysis-manager.js";
import { PassManager } from "../../infra/pass-manager.js";
import { createAnalysisRegistry } from "../../analyses/index.js";
import { compilerOptions, type CompilerOptions } from "../../options.js";
import { cfgPassTracer, maintainGraph } from "../../pipeline.js";
import type { TargetModel } from "../../target/model.js";
import { targetLegalizationPipeline } from "../../target/legalization.js";
import type {
  CompileRejection,
  JitBackend,
  JitCompileRequest,
  JitCompileResult,
} from "../../target/jit.js";
import { isBackendLoweringError } from "../../target/errors.js";
import { WasmCodegen } from "./codegen.js";
import { wasmTarget } from "./target.js";

export class WasmBackend implements JitBackend {
  readonly id = "wasm";
  readonly mode = "jit" as const;
  readonly target: TargetModel = wasmTarget;

  constructor(private readonly codegen: WasmCodegen = new WasmCodegen()) {}

  loweringPipeline() {
    return targetLegalizationPipeline(this.target);
  }

  jitCompile(request: JitCompileRequest): JitCompileResult {
    const legalization = this.legalize(request.unit.graph, request.unit.analyses);
    if (legalization !== null) {
      return { code: null, rejection: { compileRejection: legalization, analysisFailure: null } };
    }
    const code = this.codegen.compile(request.unit);
    return {
      code,
      rejection: {
        compileRejection: this.codegen.lastCompileRejection,
        analysisFailure: this.codegen.lastAnalysisFailure,
      },
    };
  }

  private legalize(
    graph: CFGFunction,
    analyses: AnalysisManager<CFGFunction> | undefined,
    options: CompilerOptions = compilerOptions(),
  ): CompileRejection | null {
    const manager = analyses ?? new AnalysisManager(graph, createAnalysisRegistry());
    try {
      new PassManager(manager, options, cfgPassTracer(options), maintainGraph).run(
        graph,
        this.loweringPipeline(),
      );
      return null;
    } catch (error) {
      if (!isBackendLoweringError(error)) throw error;
      return { kind: "unsupported", reason: error.message };
    }
  }
}
