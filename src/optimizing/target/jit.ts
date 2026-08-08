import type {
  OptimizedCode,
  RegisterCompiledFunction,
} from "../../bytecode/register/ops/bytecode.js";
import type { SpeculativeCompileResult } from "../optimizer.js";
import type { CodeBackend } from "./backend.js";

export interface JitCompileRequest {
  readonly result: SpeculativeCompileResult;
  readonly compiledFn: RegisterCompiledFunction;
}

export interface JitRejection {
  readonly compileRejection: string | null;
  readonly analysisFailure: string | null;
}

export interface JitCompileResult {
  readonly code: OptimizedCode | null;
  readonly rejection: JitRejection;
}

export interface JitBackend extends CodeBackend {
  readonly mode: "jit";
  jitCompile(request: JitCompileRequest): JitCompileResult;
}

export function isJitBackend(backend: CodeBackend): backend is JitBackend {
  return backend.mode === "jit";
}
