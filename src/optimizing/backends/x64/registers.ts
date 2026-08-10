import { RegisterFile, type PhysicalRegister } from "../../target/registers.js";

export const X64_GPR = "gpr";
export const X64_FPR = "fpr";

const GPR_FORMS = new Map<string, readonly [string, string, string, string]>([
  ["rax", ["rax", "eax", "ax", "al"]],
  ["rbx", ["rbx", "ebx", "bx", "bl"]],
  ["rcx", ["rcx", "ecx", "cx", "cl"]],
  ["rdx", ["rdx", "edx", "dx", "dl"]],
  ["rsi", ["rsi", "esi", "si", "sil"]],
  ["rdi", ["rdi", "edi", "di", "dil"]],
  ["rbp", ["rbp", "ebp", "bp", "bpl"]],
  ["rsp", ["rsp", "esp", "sp", "spl"]],
  ["r8", ["r8", "r8d", "r8w", "r8b"]],
  ["r9", ["r9", "r9d", "r9w", "r9b"]],
  ["r10", ["r10", "r10d", "r10w", "r10b"]],
  ["r11", ["r11", "r11d", "r11w", "r11b"]],
  ["r12", ["r12", "r12d", "r12w", "r12b"]],
  ["r13", ["r13", "r13d", "r13w", "r13b"]],
  ["r14", ["r14", "r14d", "r14w", "r14b"]],
  ["r15", ["r15", "r15d", "r15w", "r15b"]],
]);

const WIDTH_INDEX = new Map<number, number>([
  [8, 0],
  [4, 1],
  [2, 2],
  [1, 3],
]);

export const X64_GPR_NAMES: readonly string[] = [...GPR_FORMS.keys()];
export const X64_FPR_NAMES: readonly string[] = Array.from(
  { length: 16 },
  (_unused, index) => `xmm${index}`,
);

export const X64_GPR_SCRATCH: readonly string[] = ["r10", "r11"];
export const X64_FPR_SCRATCH: readonly string[] = ["xmm14", "xmm15"];
export const X64_GPR_RESERVED: readonly string[] = ["rsp", "rbp"];

export function x64RegisterName(register: PhysicalRegister, width: number): string {
  const forms = GPR_FORMS.get(register.name);
  if (forms === undefined) return register.name;
  const index = WIDTH_INDEX.get(width);
  if (index === undefined) throw new Error(`no x64 register form for width ${width}`);
  return forms[index]!;
}

export function x64RegisterFile(
  gprAllocation: readonly string[],
  fprAllocation: readonly string[],
): RegisterFile {
  return new RegisterFile([
    {
      id: X64_GPR,
      width: 8,
      saveBytes: 8,
      allocation: gprAllocation,
      scratch: X64_GPR_SCRATCH,
      reserved: X64_GPR_RESERVED,
    },
    {
      id: X64_FPR,
      width: 8,
      saveBytes: 16,
      allocation: fprAllocation,
      scratch: X64_FPR_SCRATCH,
    },
  ]);
}
