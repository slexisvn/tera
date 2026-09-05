import {
  STACK_GUARD_GRANULE_BYTES,
  type CallingConvention,
  type RuntimeAbi,
} from "../../target/abi.js";
import type { RegisterFile } from "../../target/registers.js";
import {
  RISCV_CALLEE_SAVED,
  RISCV_CALLER_SAVED,
  RISCV_FLOAT_ARGUMENTS,
  RISCV_FPR,
  RISCV_GPR,
  RISCV_INTEGER_ARGUMENTS,
  riscvRegisterFile,
} from "./registers.js";

export interface RiscvAbi {
  readonly registers: RegisterFile;
  readonly abi: RuntimeAbi;
}

export function riscvAbi(): RiscvAbi {
  const registers = riscvRegisterFile();
  const callingConvention: CallingConvention = {
    name: "lp64d",
    argumentRegisters: new Map([
      [RISCV_GPR, registers.select(RISCV_INTEGER_ARGUMENTS)],
      [RISCV_FPR, registers.select(RISCV_FLOAT_ARGUMENTS)],
    ]),
    returnRegisters: new Map([
      [RISCV_GPR, registers.register("a0")],
      [RISCV_FPR, registers.register("fa0")],
    ]),
    callerSaved: registers.select(RISCV_CALLER_SAVED),
    calleeSaved: registers.select(RISCV_CALLEE_SAVED),
    sharedArgumentPositions: false,
    shadowSpaceBytes: 0,
    stackArgumentSlotBytes: 8,
  };

  return {
    registers,
    abi: {
      name: "riscv64 lp64d",
      pointerWidthBytes: 8,
      stackAlignmentBytes: 16,
      entryStackAdjustBytes: 0,
      stackProbeBytes: STACK_GUARD_GRANULE_BYTES,
      framePointer: registers.register("s0"),
      stackPointer: registers.register("sp"),
      savedOnCall: registers.select(["ra"]),
      callingConvention,
    },
  };
}
