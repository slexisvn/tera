import type { MachineFunction } from "../machine/ir.js";
import type { ClassTable } from "../metadata/class-table.js";
import type { EntryDelivery } from "./entry.js";
import type { AotScalar } from "../types/scalar.js";

export interface BackendArtifact {
  readonly kind: string;
}

export interface CArtifact extends BackendArtifact {
  readonly kind: "c";
  readonly prototype: string;
  readonly source: string;
  readonly headerPreamble: string;
  readonly sourcePreamble: string;
  readonly translationUnitPreamble: string;
}

export interface NativeArtifact extends BackendArtifact {
  readonly kind: "native";
  readonly prototype: string;
  readonly fn: MachineFunction;
  readonly headerPreamble: string;
  readonly runtimeSupport: readonly NativeRuntimeRoutine[];
}

export function isCArtifact(artifact: BackendArtifact): artifact is CArtifact {
  return artifact.kind === "c";
}

export function isNativeArtifact(artifact: BackendArtifact): artifact is NativeArtifact {
  return artifact.kind === "native";
}

export interface NativeRuntimeRoutine {
  readonly symbol: string;
  readonly fn: MachineFunction;
}

export interface EmittedFunction {
  readonly symbol: string;
  readonly internal?: boolean;
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

export type AotOutputFormat = "assembly" | "object" | "executable";

export interface AotSkippedFunction {
  readonly name: string;
  readonly reason: string;
  readonly missing?: string;
}

export interface AotLinkOptions {
  readonly moduleName: string;
  readonly classes?: ClassTable | null;
  readonly format?: AotOutputFormat;
  readonly entry?: string;
  readonly result?: EntryDelivery;
  readonly skipped?: readonly AotSkippedFunction[];
  readonly moduleInits?: readonly string[];
  readonly heapBytes?: number;
}
