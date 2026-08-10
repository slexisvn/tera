import type { CFGFunction } from "../ir/index.js";
import type { AnalysisManager } from "../infra/analysis-manager.js";
import { aotLegalityAnalysisId } from "../analyses/aot-legality.js";
import type { AotBackend, LinkableFunction } from "../target/backend.js";
import type { Emitter } from "../target/emitter.js";
import type {
  AotLinkOptions,
  AotOutputFile,
  NativeRuntimeRoutine,
} from "../target/artifact.js";
import { BackendLoweringError } from "../target/errors.js";
import { prototypeOf } from "../target/c-types.js";
import { targetLegalizationPipeline } from "../target/legalization.js";
import type { MachineTargetModel } from "../target/model.js";
import type { FrameLayout } from "./frame.js";
import type { MachineDatum, MachineFunction } from "./ir.js";
import type { MachineLowering } from "./lowering.js";
import { compileMachineFunction } from "./pipeline.js";
import { nativeReturnScalar } from "./signature.js";

export interface NativeTargetModel extends MachineTargetModel {
  readonly runtime: ReadonlyMap<string, NativeRuntimeRoutine>;
  symbolOf(name: string): string;
}

export interface NativeAssemblyWriter {
  functionText(fn: MachineFunction, frame: FrameLayout): string;
  dataText(items: readonly MachineDatum[]): string;
  runtimeText(symbol: string, body: string): string;
}

export interface NativeBackendOptions {
  readonly id: string;
  readonly lowering: MachineLowering & { readonly target: NativeTargetModel };
  readonly writer: NativeAssemblyWriter;
  readonly headerPreamble: string;
}

export class NativeBackendError extends BackendLoweringError {
  constructor(id: string, reason: string) {
    super(`${id} backend cannot emit: ${reason}`);
    this.name = "NativeBackendError";
  }
}

interface NativePart {
  readonly prototype: string;
  readonly assembly: string;
  readonly runtime: readonly NativeRuntimeRoutine[];
}

function includeGuard(headerName: string): string {
  const token = headerName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return /^[A-Z_]/.test(token) ? token : `H_${token}`;
}

function nativeParts(functions: readonly LinkableFunction[]): NativePart[] {
  const parts: NativePart[] = [];
  for (const fn of functions) {
    const artifact = fn.emitted.artifact;
    if (artifact.kind !== "native") continue;
    parts.push({
      prototype: artifact.prototype,
      assembly: artifact.assembly,
      runtime: artifact.runtimeSupport,
    });
  }
  return parts;
}

export function createNativeBackend(options: NativeBackendOptions): AotBackend {
  const { id, lowering, writer, headerPreamble } = options;
  const target = lowering.target;

  return {
    id,
    mode: "aot",
    target,
    loweringPipeline: () => targetLegalizationPipeline(target),
    createEmitter(graph: CFGFunction, analyses: AnalysisManager<CFGFunction>): Emitter {
      return {
        emit: () => {
          const result = analyses.get(aotLegalityAnalysisId);
          if (!result.ok) throw new NativeBackendError(id, result.reason);
          const legality = result.legality;
          const symbol = target.symbolOf(graph.name);
          const returns = nativeReturnScalar(legality);
          const compiled = compileMachineFunction(graph, legality, lowering, analyses, symbol);
          const runtime: NativeRuntimeRoutine[] = [];
          for (const external of compiled.fn.externals) {
            const routine = target.runtime.get(external);
            if (routine !== undefined) runtime.push(routine);
          }
          return {
            symbol,
            parameterCount: legality.parameterScalars.length,
            references: [...compiled.fn.references],
            artifact: {
              kind: "native",
              prototype: `${prototypeOf(symbol, returns, legality.parameterScalars)};`,
              assembly:
                writer.functionText(compiled.fn, compiled.frame) +
                writer.dataText(compiled.fn.data.items),
              headerPreamble,
              runtimeSupport: runtime,
            },
          };
        },
      };
    },
    link(
      functions: readonly LinkableFunction[],
      linkOptions: AotLinkOptions,
    ): readonly AotOutputFile[] {
      const headerName = `${linkOptions.moduleName}.h`;
      const assemblyName = `${linkOptions.moduleName}.s`;
      const parts = nativeParts(functions);
      const guard = includeGuard(headerName);
      const prototypes = parts.map((part) => part.prototype).join("\n");
      const routines = new Map<string, NativeRuntimeRoutine>();
      for (const part of parts) {
        for (const routine of part.runtime) routines.set(routine.symbol, routine);
      }
      const header =
        `#ifndef ${guard}\n#define ${guard}\n\n${headerPreamble}\n\n` +
        (prototypes.length > 0 ? `${prototypes}\n\n` : "") +
        `#endif\n`;
      const assembly = [
        ...[...routines.values()].map((routine) =>
          writer.runtimeText(routine.symbol, routine.text),
        ),
        ...parts.map((part) => part.assembly),
      ].join("\n");
      return [
        { name: headerName, contents: header },
        { name: assemblyName, contents: assembly },
      ];
    },
  };
}
