import type { CallingConvention, RuntimeAbi } from "../../target/abi.js";
import type { PhysicalRegister, RegisterFile } from "../../target/registers.js";
import { X64_FPR, X64_GPR, x64RegisterFile } from "./registers.js";

export type X64AbiName = "sysv" | "win64";

export interface X64Abi {
  readonly registers: RegisterFile;
  readonly abi: RuntimeAbi;
}

interface X64AbiSpec {
  readonly integerArguments: readonly string[];
  readonly floatArguments: readonly string[];
  readonly callerSaved: readonly string[];
  readonly calleeSaved: readonly string[];
  readonly sharedArgumentPositions: boolean;
  readonly shadowSpaceBytes: number;
}

const ALLOCATABLE_GPR: readonly string[] = [
  "rax", "rcx", "rdx", "rbx", "rsi", "rdi", "r8", "r9", "r12", "r13", "r14", "r15",
];

const ALLOCATABLE_FPR: readonly string[] = Array.from(
  { length: 14 },
  (_unused, index) => `xmm${index}`,
);

const SPECS: Record<X64AbiName, X64AbiSpec> = {
  sysv: {
    integerArguments: ["rdi", "rsi", "rdx", "rcx", "r8", "r9"],
    floatArguments: ["xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"],
    callerSaved: [
      "rax", "rcx", "rdx", "rsi", "rdi", "r8", "r9", "r10", "r11",
      ...Array.from({ length: 16 }, (_unused, index) => `xmm${index}`),
    ],
    calleeSaved: ["rbx", "r12", "r13", "r14", "r15"],
    sharedArgumentPositions: false,
    shadowSpaceBytes: 0,
  },
  win64: {
    integerArguments: ["rcx", "rdx", "r8", "r9"],
    floatArguments: ["xmm0", "xmm1", "xmm2", "xmm3"],
    callerSaved: [
      "rax", "rcx", "rdx", "r8", "r9", "r10", "r11",
      "xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5",
    ],
    calleeSaved: [
      "rbx", "rsi", "rdi", "r12", "r13", "r14", "r15",
      ...Array.from({ length: 10 }, (_unused, index) => `xmm${index + 6}`),
    ],
    sharedArgumentPositions: true,
    shadowSpaceBytes: 32,
  },
};

function allocationOrder(
  candidates: readonly string[],
  callerSaved: ReadonlySet<string>,
): readonly string[] {
  return [
    ...candidates.filter((name) => callerSaved.has(name)),
    ...candidates.filter((name) => !callerSaved.has(name)),
  ];
}

export function x64Abi(name: X64AbiName): X64Abi {
  const spec = SPECS[name];
  const volatiles = new Set(spec.callerSaved);
  const registers = x64RegisterFile(
    allocationOrder(ALLOCATABLE_GPR, volatiles),
    allocationOrder(ALLOCATABLE_FPR, volatiles),
  );
  const select = (names: readonly string[]): readonly PhysicalRegister[] =>
    registers.select(names);

  const callingConvention: CallingConvention = {
    name,
    argumentRegisters: new Map([
      [X64_GPR, select(spec.integerArguments)],
      [X64_FPR, select(spec.floatArguments)],
    ]),
    returnRegisters: new Map([
      [X64_GPR, registers.register("rax")],
      [X64_FPR, registers.register("xmm0")],
    ]),
    callerSaved: select(spec.callerSaved),
    calleeSaved: select(spec.calleeSaved),
    sharedArgumentPositions: spec.sharedArgumentPositions,
    shadowSpaceBytes: spec.shadowSpaceBytes,
    stackArgumentSlotBytes: 8,
  };

  return {
    registers,
    abi: {
      name: `x86-64 ${name}`,
      pointerWidthBytes: 8,
      stackAlignmentBytes: 16,
      entryStackAdjustBytes: 8,
      framePointer: registers.register("rbp"),
      stackPointer: registers.register("rsp"),
      savedOnCall: [],
      callingConvention,
    },
  };
}
