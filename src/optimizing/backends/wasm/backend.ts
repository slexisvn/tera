import type { TargetModel } from "../../target/model.js";
import type {
  JitBackend,
  JitCompileRequest,
  JitCompileResult,
} from "../../target/jit.js";
import { WasmCodegen } from "./codegen.js";
import { wasmTarget } from "./target.js";

export class WasmBackend implements JitBackend {
  readonly id = "wasm";
  readonly mode = "jit" as const;
  readonly target: TargetModel = wasmTarget;

  constructor(private readonly codegen: WasmCodegen = new WasmCodegen()) {}

  jitCompile(request: JitCompileRequest): JitCompileResult {
    const code = this.codegen.compile(request.result, request.compiledFn);
    return {
      code,
      rejection: {
        compileRejection: this.codegen.lastCompileRejection,
        analysisFailure: this.codegen.lastAnalysisFailure,
      },
    };
  }
}
