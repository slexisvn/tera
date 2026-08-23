import { capabilitySet } from "../../target/capabilities.js";
import { proveOrGeneric } from "../../target/speculation.js";
import { defaultMachineReprOf, type ScalarLocation } from "../../target/model.js";
import type { NativeTargetModel } from "../../machine/backend.js";
import { sanitizeSymbol, C_KEYWORDS, C_LIBRARY_NAMES } from "../../target/symbols.js";
import type { NativeRuntimeRoutine } from "../../target/artifact.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_CODE,
  SCALAR_POINTER,
  SCALAR_STRING,
  type AotScalar,
} from "../../types/scalar.js";
import { riscvAbi } from "./abi.js";
import { RISCV_FPR, RISCV_GPR } from "./registers.js";
import { riscvRuntimeRoutines } from "./runtime.js";
import { RISCV_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const LOCATIONS = new Map<AotScalar, ScalarLocation>([
  [SCALAR_INT32, { classId: RISCV_GPR, width: 4 }],
  [SCALAR_FLOAT64, { classId: RISCV_FPR, width: 8 }],
  [SCALAR_STRING, { classId: RISCV_GPR, width: 8 }],
  [SCALAR_POINTER, { classId: RISCV_GPR, width: 8 }],
  [SCALAR_CODE, { classId: RISCV_GPR, width: 8 }],
]);

const RESERVED_SYMBOLS = new Set<string>([
  ...C_KEYWORDS,
  ...C_LIBRARY_NAMES,
  ...Object.values(RISCV_RUNTIME_SYMBOLS),
]);

export type RiscvTargetModel = NativeTargetModel;

export function riscvTarget(): RiscvTargetModel {
  const built = riscvAbi();
  const registers = built.registers;

  return {
    name: "riscv64-lp64d",
    capabilities: capabilitySet("terminating-throw", "float-text"),
    speculation: proveOrGeneric,
    abi: built.abi,
    registers,
    integerClass: registers.classOf(RISCV_GPR),
    floatClass: registers.classOf(RISCV_FPR),
    runtime: riscvRuntimeRoutines(registers),
    locationOf: (scalar) => {
      const location = LOCATIONS.get(scalar);
      if (location === undefined) throw new Error(`no riscv64 location for ${scalar}`);
      return location;
    },
    machineReprOf: defaultMachineReprOf,
    symbolOf: (name) => sanitizeSymbol(name, RESERVED_SYMBOLS),
  };
}
