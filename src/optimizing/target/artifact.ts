import type { AotScalar } from "../types/scalar.js";

export type BackendArtifact =
  | { readonly kind: "wasm"; readonly bytes: Uint8Array }
  | {
      readonly kind: "c";
      readonly prototype: string;
      readonly source: string;
      readonly headerPreamble: string;
      readonly sourcePreamble: string;
      readonly translationUnitPreamble: string;
    }
  | {
      readonly kind: "native";
      readonly prototype: string;
      readonly assembly: string;
      readonly headerPreamble: string;
      readonly runtimeSupport: readonly NativeRuntimeRoutine[];
    }
  | { readonly kind: "llvm"; readonly module: string };

export interface NativeRuntimeRoutine {
  readonly symbol: string;
  readonly text: string;
}

export interface EmittedFunction {
  readonly symbol: string;
  readonly parameterCount: number;
  readonly parameterScalars: readonly AotScalar[];
  readonly returnScalar: AotScalar;
  readonly references: readonly string[];
  readonly artifact: BackendArtifact;
}

export interface AotOutputFile {
  readonly name: string;
  readonly contents: string | Uint8Array;
}

export interface AotLinkOptions {
  readonly moduleName: string;
}
