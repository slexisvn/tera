import type { AotBackend } from "../../target/backend.js";
import {
  createNativeBackend,
  type NativeMachineCodeSupport,
  type NativeProgramImage,
} from "../../machine/backend.js";
import type { McObjectWriter } from "../../mc/formats/container.js";
import { appendWin64Unwind, appendX64EhFrame } from "./unwind.js";
import { elf64Executable, elf64Object, ELF_MACHINE_X86_64 } from "../../mc/formats/elf64.js";
import { coffObject, peExecutable, PE_MACHINE_AMD64 } from "../../mc/formats/pe.js";
import type { RegisterFile } from "../../target/registers.js";
import { X64AssemblyWriter } from "./assembly.js";
import type { PlatformIo } from "./entry.js";
import { operatingSystemOf, type ObjectFormatName } from "./format.js";
import { X64Lowering } from "./lowering.js";
import { x64Target, type X64TargetOptions } from "./target.js";
import { x64McTarget } from "./mc/target.js";
import { X64_PROGRAM_ENTRY, x64ProgramEntry } from "./runtime.js";
import { WINDOWS_IMPORTS, WINDOWS_PROGRAM_ENTRY, windowsProgramEntry } from "./windows.js";

export const X64_HEADER_PREAMBLE = "#include <stdint.h>";

export interface X64BackendOptions extends X64TargetOptions {
  readonly id?: string;
}

interface X64Containers {
  readonly object: McObjectWriter;
  program(io: PlatformIo, registers: RegisterFile): NativeProgramImage;
}

const CONTAINERS: Record<ObjectFormatName, X64Containers | null> = {
  elf: {
    object: elf64Object(ELF_MACHINE_X86_64),
    program: (io, registers) => ({
      entrySymbol: X64_PROGRAM_ENTRY,
      writer: elf64Executable(ELF_MACHINE_X86_64),
      programEntry: (callee, shape) => x64ProgramEntry(callee, shape, io, registers),
    }),
  },
  coff: {
    object: coffObject(PE_MACHINE_AMD64),
    program: (io, registers) => ({
      entrySymbol: WINDOWS_PROGRAM_ENTRY,
      writer: peExecutable(PE_MACHINE_AMD64, WINDOWS_IMPORTS),
      programEntry: (callee, shape) => windowsProgramEntry(callee, shape, io, registers),
    }),
  },
  macho: null,
};

const X64_ARCHITECTURE = "x64";

const ehFrameFor = (format: ObjectFormatName): NativeMachineCodeSupport["unwind"] =>
  format === "elf"
    ? (module, functions, image) =>
        appendX64EhFrame(module, functions, image === "executable")
    : undefined;

export function createX64Backend(options: X64BackendOptions = {}): AotBackend {
  const target = x64Target(options);
  const format = target.objectFormat.name;
  const containers = CONTAINERS[format];
  return createNativeBackend({
    id: options.id ?? X64_ARCHITECTURE,
    platform: { os: operatingSystemOf(format), arch: X64_ARCHITECTURE },
    lowering: new X64Lowering(target),
    writer: new X64AssemblyWriter(target),
    headerPreamble: X64_HEADER_PREAMBLE,
    machineCode: {
      target: x64McTarget,
      object: containers?.object ?? null,
      program: containers?.program(target.io, target.registers) ?? null,
      unwind: format === "coff" ? appendWin64Unwind : ehFrameFor(format),
    },
  });
}
