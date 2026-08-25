import type {
  OptimizedCode,
} from "../../bytecode/register/ops/bytecode.js";
import type { CompilationUnit } from "../compilation-unit.js";
import type { CompilerOptions } from "../options.js";
import type { CodeBackend } from "./backend.js";

export type RejectionKind = "unsupported" | "speculation" | "malformed";

export interface CompileRejection {
  readonly kind: RejectionKind;
  readonly reason: string;
}

export interface JitCompileRequest {
  readonly unit: CompilationUnit;
  readonly options?: CompilerOptions;
}

export interface JitRejection {
  readonly compileRejection: CompileRejection | null;
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
