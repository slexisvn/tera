import { capabilitySet } from "../../target/capabilities.js";
import { proveOrGeneric } from "../../target/speculation.js";
import type { MachineRepr, ScalarLocation } from "../../target/model.js";
import type { NativeTargetModel } from "../../machine/backend.js";
import type { RuntimeAbi } from "../../target/abi.js";
import type { RegisterClass, RegisterFile } from "../../target/registers.js";
import { sanitizeSymbol, C_KEYWORDS, C_LIBRARY_NAMES } from "../../target/symbols.js";
import {
  REP_BOOL,
  REP_FLOAT64,
  REP_HANDLE,
  REP_INT32,
  REP_TAGGED,
  REP_TAGGED_NUMBER,
  type Representation,
} from "../../types/representation.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
  type AotScalar,
} from "../../types/scalar.js";
import { x64Abi, type X64AbiName } from "./abi.js";
import { objectFormat, hostObjectFormat, type ObjectFormat, type ObjectFormatName } from "./format.js";
import { X64_FPR, X64_GPR } from "./registers.js";
import { X64_RUNTIME_SYMBOLS, x64RuntimeRoutines } from "./runtime.js";
import type { NativeRuntimeRoutine } from "../../target/artifact.js";

const MACHINE_REPR = new Map<Representation, MachineRepr>([
  [REP_INT32, "int32"],
  [REP_FLOAT64, "float64"],
  [REP_TAGGED_NUMBER, "float64"],
  [REP_BOOL, "boolean"],
  [REP_HANDLE, "pointer"],
  [REP_TAGGED, "tagged"],
]);

const LOCATIONS = new Map<AotScalar, ScalarLocation>([
  [SCALAR_INT32, { classId: X64_GPR, width: 4 }],
  [SCALAR_FLOAT64, { classId: X64_FPR, width: 8 }],
  [SCALAR_STRING, { classId: X64_GPR, width: 8 }],
]);

const RESERVED_SYMBOLS = new Set<string>([
  ...C_KEYWORDS,
  ...C_LIBRARY_NAMES,
  ...Object.values(X64_RUNTIME_SYMBOLS),
]);

export interface X64TargetModel extends NativeTargetModel {
  readonly objectFormat: ObjectFormat;
}

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

  return {
    name: `x86-64-${abiName}`,
    capabilities: capabilitySet(),
    speculation: proveOrGeneric,
    abi,
    registers,
    integerClass,
    floatClass,
    objectFormat: objectFormat(formatName),
    runtime: x64RuntimeRoutines(abi),
    locationOf: (scalar) => {
      const location = LOCATIONS.get(scalar);
      if (location === undefined) throw new Error(`no x64 location for ${scalar}`);
      return location;
    },
    machineReprOf: (rep) => MACHINE_REPR.get(rep) ?? "pointer",
    symbolOf: (name) => sanitizeSymbol(name, RESERVED_SYMBOLS),
  };
}
