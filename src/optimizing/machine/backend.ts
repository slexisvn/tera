import type { CFGFunction } from "../ir/index.js";
import type { AnalysisManager } from "../infra/analysis-manager.js";
import { aotLegalityAnalysisId } from "../analyses/aot-legality.js";
import type { AotBackend, LinkableFunction, TargetPlatform } from "../target/backend.js";
import type { Emitter } from "../target/emitter.js";
import {
  isNativeArtifact,
  type AotLinkOptions,
  type AotOutputFile,
  type AotOutputFormat,
  type NativeRuntimeRoutine,
} from "../target/artifact.js";
import { BackendLoweringError } from "../target/errors.js";
import { prototypeOf } from "../target/c-types.js";
import { moduleInitTable } from "../target/symbols.js";
import { targetLegalizationPipeline } from "../target/legalization.js";
import type { MachineTargetModel } from "../target/model.js";
import type { FrameLayout } from "./frame.js";
import type { MachineDatum, MachineFunction } from "./ir.js";
import { assembleData, assembleFunction } from "../mc/assembler.js";
import { heapData, heapImageOf, type HeapImage } from "./heap-data.js";
import type { ClassTable } from "../metadata/class-table.js";
import type { McExecutableWriter, McObjectWriter } from "../mc/formats/container.js";
import { McModule } from "../mc/module.js";
import type { McTarget } from "../mc/target.js";
import type { MachineLowering } from "./lowering.js";
import { compileMachineFunction } from "./pipeline.js";
import { nativeReturnScalar } from "./signature.js";
import {
  defaultDelivery,
  missingEntryReason,
  programEntryShape,
  type EntryResult,
  type ProgramEntryShape,
} from "../target/entry.js";
import type { AotScalar } from "../types/scalar.js";

const PRINTABLE_RESULTS: ReadonlySet<EntryResult> = new Set(["int", "string"]);

export interface NativeTargetModel extends MachineTargetModel {
  readonly runtime: ReadonlyMap<string, NativeRuntimeRoutine>;
  symbolOf(name: string): string;
}

export interface NativeAssemblyWriter {
  functionText(fn: MachineFunction, exported?: boolean): string;
  dataText(items: readonly MachineDatum[]): string;
}

export interface NativeProgramImage {
  readonly entrySymbol: string;
  readonly writer: McExecutableWriter;
  programEntry(callee: string, shape: ProgramEntryShape): MachineFunction;
}

export interface NativeMachineCodeSupport {
  readonly target: McTarget;
  readonly object: McObjectWriter | null;
  readonly program: NativeProgramImage | null;
}

export interface NativeBackendOptions {
  readonly id: string;
  readonly platform: TargetPlatform;
  readonly lowering: MachineLowering & { readonly target: NativeTargetModel };
  readonly writer: NativeAssemblyWriter;
  readonly headerPreamble: string;
  readonly machineCode: NativeMachineCodeSupport | null;
}

export class NativeBackendError extends BackendLoweringError {
  constructor(id: string, reason: string) {
    super(`${id} backend cannot emit: ${reason}`);
    this.name = "NativeBackendError";
  }
}

interface NativePart {
  readonly name: string;
  readonly prototype: string;
  readonly fn: MachineFunction;
  readonly parameterScalars: readonly AotScalar[];
  readonly returnScalar: AotScalar;
  readonly runtime: readonly NativeRuntimeRoutine[];
  readonly internal: boolean;
}

function includeGuard(headerName: string): string {
  const token = headerName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return /^[A-Z_]/.test(token) ? token : `H_${token}`;
}

function nativeParts(functions: readonly LinkableFunction[]): NativePart[] {
  const parts: NativePart[] = [];
  for (const fn of functions) {
    const artifact = fn.emitted.artifact;
    if (!isNativeArtifact(artifact)) continue;
    parts.push({
      name: fn.name,
      prototype: artifact.prototype,
      fn: artifact.fn,
      parameterScalars: fn.emitted.parameterScalars,
      returnScalar: fn.emitted.returnScalar,
      runtime: artifact.runtimeSupport,
      internal: fn.emitted.internal === true,
    });
  }
  return parts;
}

function closeOverRoutines(
  seeds: Iterable<NativeRuntimeRoutine>,
  available: ReadonlyMap<string, NativeRuntimeRoutine>,
): ReadonlyMap<string, NativeRuntimeRoutine> {
  const routines = new Map<string, NativeRuntimeRoutine>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const routine = pending.pop()!;
    if (routines.has(routine.symbol)) continue;
    routines.set(routine.symbol, routine);
    for (const external of routine.fn.externals) {
      const referenced = available.get(external);
      if (referenced !== undefined) pending.push(referenced);
    }
  }
  return routines;
}

function requiredRoutines(
  parts: readonly NativePart[],
  available: ReadonlyMap<string, NativeRuntimeRoutine>,
): ReadonlyMap<string, NativeRuntimeRoutine> {
  return closeOverRoutines(
    parts.flatMap((part) => [...part.runtime]),
    available,
  );
}

function populate(
  module: McModule,
  support: NativeMachineCodeSupport,
  parts: readonly NativePart[],
  routines: ReadonlyMap<string, NativeRuntimeRoutine>,
  heap: HeapImage,
): void {
  assembleData(module, heapData(heap));
  for (const routine of routines.values()) {
    assembleFunction(module, support.target, routine.fn, "local");
    assembleData(module, routine.fn.data.items);
  }
  for (const part of parts) {
    assembleFunction(module, support.target, part.fn, part.internal ? "local" : "global");
    assembleData(module, part.fn.data.items);
  }
}

function objectImage(
  support: NativeMachineCodeSupport,
  writer: McObjectWriter,
  parts: readonly NativePart[],
  available: ReadonlyMap<string, NativeRuntimeRoutine>,
  heap: HeapImage,
): Uint8Array {
  const module = new McModule();
  populate(module, support, parts, requiredRoutines(parts, available), heap);
  return writer.image(module, support.target);
}

function executableImage(
  support: NativeMachineCodeSupport,
  program: NativeProgramImage,
  parts: readonly NativePart[],
  entry: NativePart,
  shape: ProgramEntryShape,
  available: ReadonlyMap<string, NativeRuntimeRoutine>,
  heap: HeapImage,
): Uint8Array {
  const start = program.programEntry(entry.fn.symbol, shape);
  const seeds = [
    ...parts.flatMap((part) => [...part.runtime]),
    ...[...start.externals].flatMap((external) => {
      const routine = available.get(external);
      return routine === undefined ? [] : [routine];
    }),
  ];
  const routines = closeOverRoutines(seeds, available);
  const module = new McModule();
  populate(module, support, parts, routines, heap);
  assembleFunction(module, support.target, start, "global");
  assembleData(module, start.data.items);
  return program.writer.image(module, support.target, program.entrySymbol);
}

function entryPart(
  id: string,
  parts: readonly NativePart[],
  options: AotLinkOptions,
): { readonly part: NativePart; readonly shape: ProgramEntryShape } {
  const name = options.entry;
  if (name === undefined) {
    throw new NativeBackendError(id, "an executable needs an entry function name");
  }
  const part = parts.find((candidate) => candidate.name === name);
  if (part === undefined) {
    throw new NativeBackendError(
      id,
      missingEntryReason(name, parts.map((candidate) => candidate.name), options.skipped ?? []),
    );
  }
  const shape = programEntryShape(
    part.parameterScalars,
    part.returnScalar,
    options.result ?? defaultDelivery(part.returnScalar),
  );
  if (!shape.ok) {
    throw new NativeBackendError(id, `entry function ${name} ${shape.reason}`);
  }
  if (!PRINTABLE_RESULTS.has(shape.shape.result)) {
    throw new NativeBackendError(
      id,
      `entry function ${name} returns ${part.returnScalar}, which this target cannot print`,
    );
  }
  return { part, shape: shape.shape };
}

function outputsOf(support: NativeMachineCodeSupport | null): readonly AotOutputFormat[] {
  return [
    "assembly" as const,
    ...(support?.object == null ? [] : (["object"] as const)),
    ...(support?.program == null ? [] : (["executable"] as const)),
  ];
}

export function createNativeBackend(options: NativeBackendOptions): AotBackend {
  const { id, lowering, writer, headerPreamble } = options;
  const target = lowering.target;

  return {
    id,
    mode: "aot",
    outputs: outputsOf(options.machineCode),
    platform: options.platform,
    target,
    symbolOf: (name: string) => target.symbolOf(name),
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
            if (routine === undefined) {
              throw new BackendLoweringError(
                `${target.name} has no runtime routine for ${external}`,
              );
            }
            runtime.push(routine);
          }
          return {
            symbol,
            internal: graph.internal,
            parameterCount: legality.parameterScalars.length,
            parameterScalars: legality.parameterScalars,
            returnScalar: returns,
            references: [...compiled.fn.references],
            artifact: {
              kind: "native",
              prototype: `${prototypeOf(symbol, returns, legality.parameterScalars)};`,
              fn: compiled.fn,
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
      const parts = nativeParts(functions);
      const guard = includeGuard(headerName);
      const prototypes = parts
        .filter((part) => !part.internal)
        .map((part) => part.prototype)
        .join("\n");
      const initTable = moduleInitTable(linkOptions.moduleInits ?? []);
      const header =
        `#ifndef ${guard}\n#define ${guard}\n\n${headerPreamble}\n\n` +
        (prototypes.length > 0 ? `${prototypes}\n\n` : "") +
        (initTable.length > 0 ? `${initTable}\n\n` : "") +
        `#endif\n`;

      if (linkOptions.format === "object" || linkOptions.format === "executable") {
        const support = options.machineCode;
        if (support === null) {
          throw new NativeBackendError(id, "this target has no machine code encoder");
        }
        if (linkOptions.format === "executable") {
          const program = support.program;
          if (program === null) {
            throw new NativeBackendError(id, "this target has no executable container");
          }
          const { part, shape } = entryPart(id, parts, linkOptions);
          return [
            {
              name: `${linkOptions.moduleName}.${program.writer.extension}`,
              contents: executableImage(
                support,
                program,
                parts,
                part,
                shape,
                target.runtime,
                heapImageOf(linkOptions.classes ?? null, linkOptions.heapBytes),
              ),
            },
          ];
        }
        const writer = support.object;
        if (writer === null) {
          throw new NativeBackendError(id, "this target has no object container");
        }
        return [
          { name: headerName, contents: header },
          {
            name: `${linkOptions.moduleName}.${writer.extension}`,
            contents: objectImage(
              support,
              writer,
              parts,
              target.runtime,
              heapImageOf(linkOptions.classes ?? null, linkOptions.heapBytes),
            ),
          },
        ];
      }

      const assembly = [
        ...[...requiredRoutines(parts, target.runtime).values()].map(
          (routine) =>
            writer.functionText(routine.fn, false) + writer.dataText(routine.fn.data.items),
        ),
        ...parts.map(
          (part) =>
            writer.functionText(part.fn, !part.internal) + writer.dataText(part.fn.data.items),
        ),
        writer.dataText(heapData(heapImageOf(linkOptions.classes ?? null, linkOptions.heapBytes))),
      ].join("\n");
      return [
        { name: headerName, contents: header },
        { name: `${linkOptions.moduleName}.s`, contents: assembly },
      ];
    },
  };
}
