import type {
  OptimizedCode,
} from "../../bytecode/register/ops/bytecode.js";
import type { CompilationUnit } from "../compilation-unit.js";
import type { CodeBackend } from "./backend.js";

export interface JitCompileRequest {
  readonly unit: CompilationUnit;
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
