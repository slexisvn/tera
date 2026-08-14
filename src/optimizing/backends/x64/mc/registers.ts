import type { PhysicalRegister } from "../../../target/registers.js";
import { X64_FPR, X64_GPR } from "../registers.js";

const GPR_NUMBERS = new Map<string, number>([
  ["rax", 0],
  ["rcx", 1],
  ["rdx", 2],
  ["rbx", 3],
  ["rsp", 4],
  ["rbp", 5],
  ["rsi", 6],
  ["rdi", 7],
  ["r8", 8],
  ["r9", 9],
  ["r10", 10],
  ["r11", 11],
  ["r12", 12],
  ["r13", 13],
  ["r14", 14],
  ["r15", 15],
]);

const LEGACY_BYTE_ALIASES: ReadonlySet<string> = new Set(["rsp", "rbp", "rsi", "rdi"]);

export const STACK_POINTER_NUMBER = 4;
export const FRAME_POINTER_NUMBER = 5;

export function x64RegisterNumber(register: PhysicalRegister): number {
  if (register.classId === X64_FPR) {
    const parsed = Number.parseInt(register.name.slice(3), 10);
    if (Number.isNaN(parsed)) throw new Error(`${register.name} is not an xmm register`);
    return parsed;
  }
  const number = GPR_NUMBERS.get(register.name);
  if (number === undefined) throw new Error(`${register.name} has no x64 encoding`);
  return number;
}

export function needsRexForByteAccess(register: PhysicalRegister): boolean {
  return register.classId === X64_GPR && LEGACY_BYTE_ALIASES.has(register.name);
}

export function isFloatRegister(register: PhysicalRegister): boolean {
  return register.classId === X64_FPR;
}
