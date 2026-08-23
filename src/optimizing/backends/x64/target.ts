import { capabilitySet } from "../../target/capabilities.js";
import { proveOrGeneric } from "../../target/speculation.js";
import { defaultMachineReprOf, type ScalarLocation } from "../../target/model.js";
import type { NativeTargetModel } from "../../machine/backend.js";
import type { RuntimeAbi } from "../../target/abi.js";
import type { RegisterClass, RegisterFile } from "../../target/registers.js";
import { sanitizeSymbol, C_KEYWORDS, C_LIBRARY_NAMES } from "../../target/symbols.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_CODE,
  SCALAR_POINTER,
  SCALAR_STRING,
  type AotScalar,
} from "../../types/scalar.js";
import { x64Abi, type X64AbiName } from "./abi.js";
import { objectFormat, hostObjectFormat, type ObjectFormat, type ObjectFormatName } from "./format.js";
import type { PlatformIo } from "./entry.js";
import { X64_FPR, X64_GPR } from "./registers.js";
import {
  LINUX_SYSCALLS,
  MACOS_SYSCALLS,
  sysvIo,
  X64_RUNTIME_SYMBOLS,
  x64RuntimeRoutines,
} from "./runtime.js";
import { windowsIo } from "./windows.js";

const LOCATIONS = new Map<AotScalar, ScalarLocation>([
  [SCALAR_INT32, { classId: X64_GPR, width: 4 }],
  [SCALAR_FLOAT64, { classId: X64_FPR, width: 8 }],
  [SCALAR_STRING, { classId: X64_GPR, width: 8 }],
  [SCALAR_POINTER, { classId: X64_GPR, width: 8 }],
  [SCALAR_CODE, { classId: X64_GPR, width: 8 }],
]);

const RESERVED_SYMBOLS = new Set<string>([
  ...C_KEYWORDS,
  ...C_LIBRARY_NAMES,
  ...Object.values(X64_RUNTIME_SYMBOLS),
]);

export interface X64TargetModel extends NativeTargetModel {
  readonly objectFormat: ObjectFormat;
  readonly io: PlatformIo;
}

const PLATFORM_IO: Record<ObjectFormatName, (abi: RuntimeAbi) => PlatformIo> = {
  elf: (abi) => sysvIo(abi, LINUX_SYSCALLS),
  macho: (abi) => sysvIo(abi, MACOS_SYSCALLS),
  coff: windowsIo,
};

export interface X64TargetOptions {
  readonly abi?: X64AbiName;
  readonly format?: ObjectFormatName;
}

function hostAbiName(platform: string): X64AbiName {
  return platform === "win32" ? "win64" : "sysv";
}

export function x64Target(options: X64TargetOptions = {}): X64TargetModel {
  const abiName = options.abi ?? hostAbiName(process.platform);
  const formatName = options.format ?? hostObjectFormat(process.platform);
  const built = x64Abi(abiName);
  const registers: RegisterFile = built.registers;
  const abi: RuntimeAbi = built.abi;
  const integerClass: RegisterClass = registers.classOf(X64_GPR);
  const floatClass: RegisterClass = registers.classOf(X64_FPR);
  const io = PLATFORM_IO[formatName](abi);

  return {
    name: `x86-64-${abiName}`,
    capabilities: capabilitySet(
      "terminating-throw",
      "float-text",
      "select-integer",
      "generational-heap",
      ...(io.now === undefined || io.wait === undefined
        ? []
        : (["timers"] as const)),
    ),
    speculation: proveOrGeneric,
    abi,
    registers,
    integerClass,
    floatClass,
    objectFormat: objectFormat(formatName),
    io,
    runtime: x64RuntimeRoutines(abi, registers, io),
    locationOf: (scalar) => {
      const location = LOCATIONS.get(scalar);
      if (location === undefined) throw new Error(`no x64 location for ${scalar}`);
      return location;
    },
    machineReprOf: defaultMachineReprOf,
    symbolOf: (name) => sanitizeSymbol(name, RESERVED_SYMBOLS),
  };
}
