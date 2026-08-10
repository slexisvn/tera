import { RegisterFile } from "../../target/registers.js";

export const RISCV_GPR = "gpr";
export const RISCV_FPR = "fpr";

const SAVED_GPR = Array.from({ length: 12 }, (_unused, index) => `s${index}`);
const TEMP_GPR = Array.from({ length: 7 }, (_unused, index) => `t${index}`);
const ARG_GPR = Array.from({ length: 8 }, (_unused, index) => `a${index}`);
const SAVED_FPR = Array.from({ length: 12 }, (_unused, index) => `fs${index}`);
const TEMP_FPR = Array.from({ length: 12 }, (_unused, index) => `ft${index}`);
const ARG_FPR = Array.from({ length: 8 }, (_unused, index) => `fa${index}`);

export const RISCV_GPR_SCRATCH: readonly string[] = ["t5", "t6"];
export const RISCV_FPR_SCRATCH: readonly string[] = ["ft10", "ft11"];
export const RISCV_GPR_RESERVED: readonly string[] = ["zero", "ra", "sp", "gp", "tp", "s0"];

export const RISCV_INTEGER_ARGUMENTS: readonly string[] = ARG_GPR;
export const RISCV_FLOAT_ARGUMENTS: readonly string[] = ARG_FPR;

export const RISCV_CALLER_SAVED: readonly string[] = [
  "ra",
  ...TEMP_GPR,
  ...ARG_GPR,
  ...TEMP_FPR,
  ...ARG_FPR,
];

export const RISCV_CALLEE_SAVED: readonly string[] = [...SAVED_GPR, ...SAVED_FPR];

const ALLOCATABLE_GPR: readonly string[] = [
  ...ARG_GPR,
  ...TEMP_GPR.filter((name) => !RISCV_GPR_SCRATCH.includes(name)),
  ...SAVED_GPR.filter((name) => name !== "s0"),
];

const ALLOCATABLE_FPR: readonly string[] = [
  ...ARG_FPR,
  ...TEMP_FPR.filter((name) => !RISCV_FPR_SCRATCH.includes(name)),
  ...SAVED_FPR,
];

function allocationOrder(
  candidates: readonly string[],
  callerSaved: ReadonlySet<string>,
): readonly string[] {
  return [
    ...candidates.filter((name) => callerSaved.has(name)),
    ...candidates.filter((name) => !callerSaved.has(name)),
  ];
}

export function riscvRegisterFile(): RegisterFile {
  const volatiles = new Set(RISCV_CALLER_SAVED);
  return new RegisterFile([
    {
      id: RISCV_GPR,
      width: 8,
      saveBytes: 8,
      allocation: allocationOrder(ALLOCATABLE_GPR, volatiles),
      scratch: RISCV_GPR_SCRATCH,
      reserved: RISCV_GPR_RESERVED,
    },
    {
      id: RISCV_FPR,
      width: 8,
      saveBytes: 8,
      allocation: allocationOrder(ALLOCATABLE_FPR, volatiles),
      scratch: RISCV_FPR_SCRATCH,
    },
  ]);
}
