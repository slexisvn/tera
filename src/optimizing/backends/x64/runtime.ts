import type { NativeRuntimeRoutine } from "../../target/artifact.js";
import type { RuntimeAbi } from "../../target/abi.js";
import type { RegisterFile } from "../../target/registers.js";
import {
  INT32_DECIMAL_BYTES,
  integerData,
  zeroFilledBuffer,
  type MachineDataItem,
} from "../../machine/data.js";
import {
  imm,
  mem,
  type MachineFunction,
  type MachineOperand,
  type RegisterOperand,
} from "../../machine/ir.js";
import { routine, type MachineRoutineBuilder } from "../../machine/routine.js";
import type { ProgramEntryShape } from "../../target/entry.js";
import { x64IntegerArgumentNames } from "./abi.js";
import {
  STANDARD_ERROR_STREAM,
  STANDARD_OUTPUT_STREAM,
  x64Entry,
  type PlatformIo,
  type ProgramStream,
} from "./entry.js";
import { x64FloatTextRoutines } from "./float-text.js";
import { x64HeapRoutines } from "./heap.js";
import { x64IoRoutines } from "./io.js";
import { X64_PROGRAM_ENTRY, X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";
import { TERA_EXIT_HEAP_EXHAUSTED } from "../../target/faults.js";

export { X64_PROGRAM_ENTRY, X64_RUNTIME_SYMBOLS };

export const SIGN_MASK_KEY = "x64:sign-mask";
export const ABS_MASK_KEY = "x64:abs-mask";

const MASKS = new Map<string, readonly MachineDataItem[]>([
  [SIGN_MASK_KEY, [integerData(-0x8000000000000000n, 8), integerData(0, 8)]],
  [ABS_MASK_KEY, [integerData(0x7fffffffffffffffn, 8), integerData(0, 8)]],
]);

const DIGIT_ZERO = 48;
const MINUS_SIGN = 45;
const RADIX = 10;
const INT32_MIN = -2147483648;
const MANTISSA_BITS = 52;
const EXPONENT_MASK = 2047;
const EXPONENT_BIAS = 1075;
const STDIN = 0;

const SYSV_STREAMS = new Map<ProgramStream, number>([
  [STANDARD_OUTPUT_STREAM, 1],
  [STANDARD_ERROR_STREAM, 2],
]);
const SYSCALL_NUMBER = "rax";
const SYSCALL_ARGUMENTS: readonly string[] = ["rdi", "rsi", "rdx", "r10", "r8", "r9"];

export interface SysvSyscalls {
  readonly read: number;
  readonly write: number;
  readonly exit: number;
  readonly mmap: number;
  readonly mapFlags: number;
}

const PROT_READ_WRITE = 0x1 | 0x2;
const MAP_PRIVATE = 0x02;
const LINUX_MAP_ANONYMOUS = 0x20;
const LINUX_MAP_NORESERVE = 0x4000;
const MACOS_MAP_ANONYMOUS = 0x1000;
const MMAP_ANY_ADDRESS = 0;
const MMAP_NO_FILE = -1;
const MMAP_NO_OFFSET = 0;
const MMAP_ERROR_LIMIT = -4095;

export const LINUX_SYSCALLS: SysvSyscalls = {
  read: 0,
  write: 1,
  exit: 60,
  mmap: 9,
  mapFlags: MAP_PRIVATE | LINUX_MAP_ANONYMOUS | LINUX_MAP_NORESERVE,
};

const MACOS_CLASS_UNIX = 0x2000000;

export const MACOS_SYSCALLS: SysvSyscalls = {
  read: MACOS_CLASS_UNIX | 3,
  write: MACOS_CLASS_UNIX | 4,
  exit: MACOS_CLASS_UNIX | 1,
  mmap: MACOS_CLASS_UNIX | 197,
  mapFlags: MAP_PRIVATE | MACOS_MAP_ANONYMOUS,
};

export function x64MaskData(key: string): readonly MachineDataItem[] {
  const items = MASKS.get(key);
  if (items === undefined) throw new Error(`no x64 mask named ${key}`);
  return items;
}

function toInt32(builder: MachineRoutineBuilder): void {
  builder
    .emit("cvttsd2siq", builder.write("rax", 8), builder.read("xmm0", 8))
    .emit("movabsq", builder.write("rdx", 8), imm(-0x8000000000000000n))
    .emit("cmpq", builder.read("rax", 8), builder.read("rdx", 8))
    .to("jne", "done")
    .emit("movq", builder.write("rdx", 8), builder.read("xmm0", 8))
    .emit("movq", builder.write("rcx", 8), builder.read("rdx", 8))
    .emit("shrq", builder.write("rcx", 8), imm(MANTISSA_BITS))
    .emit("andl", builder.write("rcx", 4), imm(EXPONENT_MASK))
    .emit("subl", builder.write("rcx", 4), imm(EXPONENT_BIAS))
    .emit("cmpl", builder.read("rcx", 4), imm(32))
    .to("jge", "zero")
    .emit("movabsq", builder.write("rax", 8), imm(0xfffffffffffffn))
    .emit("andq", builder.write("rax", 8), builder.read("rdx", 8))
    .emit("movabsq", builder.write("r8", 8), imm(0x10000000000000n))
    .emit("orq", builder.write("rax", 8), builder.read("r8", 8))
    .emit("shlq", builder.write("rax", 8), builder.read("rcx", 1))
    .emit("testq", builder.read("rdx", 8), builder.read("rdx", 8))
    .to("jns", "done")
    .emit("negl", builder.write("rax", 4))
    .at("done")
    .ret()
    .at("zero")
    .emit("xorl", builder.write("rax", 4), builder.read("rax", 4))
    .ret();
}

function divide(abi: RuntimeAbi, remainder: boolean) {
  const [first, second] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    builder
      .emit("movl", builder.write("rax", 4), builder.read(first!, 4))
      .emit("movl", builder.write("r8", 4), builder.read(second!, 4))
      .emit("testl", builder.read("r8", 4), builder.read("r8", 4))
      .to("je", "zero")
      .emit("cmpl", builder.read("r8", 4), imm(-1))
      .to("jne", "divide")
      .emit("cmpl", builder.read("rax", 4), imm(INT32_MIN))
      .to("je", "zero")
      .at("divide")
      .emit("cltd")
      .emit("idivl", builder.read("r8", 4));
    if (remainder) builder.emit("movl", builder.write("rax", 4), builder.read("rdx", 4));
    builder
      .ret()
      .at("zero")
      .emit("xorl", builder.write("rax", 4), builder.read("rax", 4))
      .ret();
  };
}

function extremum(keepFirst: string) {
  return (builder: MachineRoutineBuilder): void => {
    builder
      .emit("ucomisd", builder.read("xmm0", 8), builder.read("xmm1", 8))
      .to("jp", "nan")
      .to(keepFirst, "done")
      .emit("movapd", builder.write("xmm0", 8), builder.read("xmm1", 8))
      .at("done")
      .ret()
      .at("nan")
      .emit("subsd", builder.write("xmm0", 8), builder.read("xmm0", 8))
      .emit("subsd", builder.write("xmm1", 8), builder.read("xmm1", 8))
      .emit("addsd", builder.write("xmm0", 8), builder.read("xmm1", 8))
      .ret();
  };
}

function charCodeAt(abi: RuntimeAbi) {
  const [text, position] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    builder
      .emit("movl", builder.write("rax", 4), builder.read(position!, 4))
      .emit("testl", builder.read("rax", 4), builder.read("rax", 4))
      .to("js", "zero")
      .emit("movslq", builder.write("rax", 8), builder.read("rax", 4))
      .emit(
        "movzbl",
        builder.write("rax", 4),
        mem(1, {
          base: builder.read(text!, 8),
          index: builder.read("rax", 8),
          scale: 1,
        }),
      )
      .ret()
      .at("zero")
      .emit("xorl", builder.write("rax", 4), builder.read("rax", 4))
      .ret();
  };
}

function copy(abi: RuntimeAbi, append: boolean) {
  const [destination, capacity, source] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    builder
      .emit("movq", builder.write("r10", 8), builder.read(destination!, 8))
      .emit("movl", builder.write("r11", 4), builder.read(capacity!, 4))
      .emit("movq", builder.write("rax", 8), builder.read(source!, 8))
      .emit("movq", builder.write("r9", 8), builder.read("r10", 8))
      .emit("testl", builder.read("r11", 4), builder.read("r11", 4))
      .to("jle", "done")
      .emit("decl", builder.write("r11", 4));
    if (append) {
      builder
        .at("seek")
        .emit("testl", builder.read("r11", 4), builder.read("r11", 4))
        .to("jle", "terminate")
        .emit("cmpb", mem(1, { base: builder.read("r9", 8) }), imm(0))
        .to("je", "copy")
        .emit("incq", builder.write("r9", 8))
        .emit("decl", builder.write("r11", 4))
        .to("jmp", "seek");
    }
    builder
      .at("copy")
      .emit("testl", builder.read("r11", 4), builder.read("r11", 4))
      .to("jle", "terminate")
      .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read("rax", 8) }))
      .emit("testb", builder.read("rcx", 1), builder.read("rcx", 1))
      .to("je", "terminate")
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), builder.read("rcx", 1))
      .emit("incq", builder.write("r9", 8))
      .emit("incq", builder.write("rax", 8))
      .emit("decl", builder.write("r11", 4))
      .to("jmp", "copy")
      .at("terminate")
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), imm(0))
      .at("done")
      .emit("movq", builder.write("rax", 8), builder.read("r10", 8))
      .ret();
  };
}

function charAt(abi: RuntimeAbi) {
  const [destination, capacity, source, position] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    builder
      .emit("movq", builder.write("r10", 8), builder.read(destination!, 8))
      .emit("movl", builder.write("r11", 4), builder.read(capacity!, 4))
      .emit("movq", builder.write("rax", 8), builder.read(source!, 8))
      .emit("movl", builder.write("rcx", 4), builder.read(position!, 4))
      .emit("cmpl", builder.read("r11", 4), imm(2))
      .to("jl", "empty")
      .emit("testl", builder.read("rcx", 4), builder.read("rcx", 4))
      .to("js", "empty")
      .emit("movslq", builder.write("rcx", 8), builder.read("rcx", 4))
      .at("walk")
      .emit("testq", builder.read("rcx", 8), builder.read("rcx", 8))
      .to("je", "at")
      .emit("cmpb", mem(1, { base: builder.read("rax", 8) }), imm(0))
      .to("je", "empty")
      .emit("incq", builder.write("rax", 8))
      .emit("decq", builder.write("rcx", 8))
      .to("jmp", "walk")
      .at("at")
      .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read("rax", 8) }))
      .emit("testb", builder.read("rcx", 1), builder.read("rcx", 1))
      .to("je", "empty")
      .emit("movb", mem(1, { base: builder.read("r10", 8) }), builder.read("rcx", 1))
      .emit(
        "movb",
        mem(1, { base: builder.read("r10", 8), displacement: 1 }),
        imm(0),
      )
      .to("jmp", "done")
      .at("empty")
      .emit("testl", builder.read("r11", 4), builder.read("r11", 4))
      .to("jle", "done")
      .emit("movb", mem(1, { base: builder.read("r10", 8) }), imm(0))
      .at("done")
      .emit("movq", builder.write("rax", 8), builder.read("r10", 8))
      .ret();
  };
}

function int32ToString(abi: RuntimeAbi) {
  const [destination, capacity, value] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    builder
      .emit("movq", builder.write("r10", 8), builder.read(destination!, 8))
      .emit("movl", builder.write("r11", 4), builder.read(capacity!, 4))
      .emit("movl", builder.write("rax", 4), builder.read(value!, 4))
      .emit("cmpl", builder.read("r11", 4), imm(INT32_DECIMAL_BYTES))
      .to("jl", "empty")
      .emit("movq", builder.write("r9", 8), builder.read("r10", 8))
      .emit("testl", builder.read("rax", 4), builder.read("rax", 4))
      .to("jns", "magnitude")
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), imm(MINUS_SIGN))
      .emit("incq", builder.write("r9", 8))
      .emit("movslq", builder.write("rax", 8), builder.read("rax", 4))
      .emit("negq", builder.write("rax", 8))
      .to("jmp", "digits")
      .at("magnitude")
      .emit("movslq", builder.write("rax", 8), builder.read("rax", 4))
      .at("digits")
      .emit("movq", builder.write("r8", 8), builder.read("r9", 8))
      .emit("movl", builder.write("rcx", 4), imm(RADIX))
      .at("divide")
      .emit("xorl", builder.write("rdx", 4), builder.read("rdx", 4))
      .emit("divq", builder.read("rcx", 8))
      .emit("addl", builder.write("rdx", 4), imm(DIGIT_ZERO))
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), builder.read("rdx", 1))
      .emit("incq", builder.write("r9", 8))
      .emit("testq", builder.read("rax", 8), builder.read("rax", 8))
      .to("jne", "divide")
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), imm(0))
      .emit(
        "leaq",
        builder.write("rcx", 8),
        mem(8, { base: builder.read("r9", 8), displacement: -1 }),
      )
      .at("reverse")
      .emit("cmpq", builder.read("rcx", 8), builder.read("r8", 8))
      .to("jbe", "done")
      .emit("movzbl", builder.write("rax", 4), mem(1, { base: builder.read("r8", 8) }))
      .emit("movzbl", builder.write("rdx", 4), mem(1, { base: builder.read("rcx", 8) }))
      .emit("movb", mem(1, { base: builder.read("r8", 8) }), builder.read("rdx", 1))
      .emit("movb", mem(1, { base: builder.read("rcx", 8) }), builder.read("rax", 1))
      .emit("incq", builder.write("r8", 8))
      .emit("decq", builder.write("rcx", 8))
      .to("jmp", "reverse")
      .at("empty")
      .emit("testl", builder.read("r11", 4), builder.read("r11", 4))
      .to("jle", "done")
      .emit("movb", mem(1, { base: builder.read("r10", 8) }), imm(0))
      .at("done")
      .emit("movq", builder.write("rax", 8), builder.read("r10", 8))
      .ret();
  };
}

function stringCompare(abi: RuntimeAbi) {
  const [left, right] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    builder
      .emit("movq", builder.write("r10", 8), builder.read(left!, 8))
      .emit("movq", builder.write("r11", 8), builder.read(right!, 8))
      .at("scan")
      .emit("movzbl", builder.write("rax", 4), mem(1, { base: builder.read("r10", 8) }))
      .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read("r11", 8) }))
      .emit("cmpl", builder.read("rax", 4), builder.read("rcx", 4))
      .to("jne", "differ")
      .emit("testl", builder.read("rax", 4), builder.read("rax", 4))
      .to("je", "same")
      .emit("incq", builder.write("r10", 8))
      .emit("incq", builder.write("r11", 8))
      .to("jmp", "scan")
      .at("differ")
      .emit("subl", builder.write("rax", 4), builder.read("rcx", 4))
      .ret()
      .at("same")
      .emit("xorl", builder.write("rax", 4), builder.read("rax", 4))
      .ret();
  };
}

function stringLength(abi: RuntimeAbi) {
  const [text] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    builder
      .emit("movq", builder.write("rax", 8), builder.read(text!, 8))
      .at("scan")
      .emit("cmpb", mem(1, { base: builder.read("rax", 8) }), imm(0))
      .to("je", "done")
      .emit("incq", builder.write("rax", 8))
      .to("jmp", "scan")
      .at("done")
      .emit("subq", builder.write("rax", 8), builder.read(text!, 8))
      .ret();
  };
}

interface SyscallArgument {
  readonly opcode: string;
  readonly width: number;
  readonly value: MachineOperand;
}

function immediateArgument(value: number): SyscallArgument {
  return { opcode: "movl", width: 4, value: imm(value) };
}

function registerArgument(name: string, builder: MachineRoutineBuilder): SyscallArgument {
  return { opcode: "movq", width: 8, value: builder.read(name, 8) };
}

function syscall(
  builder: MachineRoutineBuilder,
  number: number,
  args: readonly SyscallArgument[],
): void {
  args.forEach((argument, position) => {
    builder.emit(
      argument.opcode,
      builder.write(SYSCALL_ARGUMENTS[position]!, argument.width),
      argument.value,
    );
  });
  builder
    .emit("movl", builder.write(SYSCALL_NUMBER, 4), imm(number))
    .emit("syscall");
}

export function sysvIo(abi: RuntimeAbi, numbers: SysvSyscalls): PlatformIo {
  return {
    abi,
    frameBytes: 0,
    reserve: (builder, bytes, base) => {
      syscall(builder, numbers.mmap, [
        immediateArgument(MMAP_ANY_ADDRESS),
        registerArgument(bytes, builder),
        immediateArgument(PROT_READ_WRITE),
        immediateArgument(numbers.mapFlags),
        { opcode: "movq", width: 8, value: imm(MMAP_NO_FILE) },
        immediateArgument(MMAP_NO_OFFSET),
      ]);
      builder
        .emit("cmpq", builder.read(SYSCALL_NUMBER, 8), imm(MMAP_ERROR_LIMIT))
        .to("jb", "tera_reserve.mapped")
        .emit("xorl", builder.write(SYSCALL_NUMBER, 4), builder.read(SYSCALL_NUMBER, 4))
        .at("tera_reserve.mapped")
        .emit("movq", builder.write(base, 8), builder.read(SYSCALL_NUMBER, 8));
    },
    commit: (builder, _base, bytes, status) => {
      builder.emit("movq", builder.write(status, 8), builder.read(bytes, 8));
    },
    read: (builder, buffer, bytes, count) => {
      syscall(builder, numbers.read, [
        immediateArgument(STDIN),
        registerArgument(buffer, builder),
        { opcode: "movl", width: 4, value: bytes },
      ]);
      builder.emit("movq", builder.write(count, 8), builder.read(SYSCALL_NUMBER, 8));
    },
    write: (builder, text, length, stream) => {
      syscall(builder, numbers.write, [
        immediateArgument(SYSV_STREAMS.get(stream)!),
        registerArgument(text, builder),
        registerArgument(length, builder),
      ]);
    },
    exit: (builder, status) => {
      syscall(builder, numbers.exit, [
        { opcode: "movl", width: 4, value: status },
      ]);
    },
  };
}

export function x64ProgramEntry(
  callee: string,
  shape: ProgramEntryShape,
  io: PlatformIo,
  registers: RegisterFile,
): MachineFunction {
  return x64Entry(X64_PROGRAM_ENTRY, callee, shape, io, registers);
}

export function x64RuntimeRoutines(
  abi: RuntimeAbi,
  registers: RegisterFile,
  io: PlatformIo,
): ReadonlyMap<string, NativeRuntimeRoutine> {
  const definitions: readonly (readonly [
    string,
    (builder: MachineRoutineBuilder) => void,
  ])[] = [
    [X64_RUNTIME_SYMBOLS.toInt32, toInt32],
    [X64_RUNTIME_SYMBOLS.divide, divide(abi, false)],
    [X64_RUNTIME_SYMBOLS.modulo, divide(abi, true)],
    [X64_RUNTIME_SYMBOLS.minimum, extremum("jb")],
    [X64_RUNTIME_SYMBOLS.maximum, extremum("ja")],
    [X64_RUNTIME_SYMBOLS.charCodeAt, charCodeAt(abi)],
    [X64_RUNTIME_SYMBOLS.stringSet, copy(abi, false)],
    [X64_RUNTIME_SYMBOLS.stringAppend, copy(abi, true)],
    [X64_RUNTIME_SYMBOLS.charAt, charAt(abi)],
    [X64_RUNTIME_SYMBOLS.int32ToString, int32ToString(abi)],
    [X64_RUNTIME_SYMBOLS.stringLength, stringLength(abi)],
    [X64_RUNTIME_SYMBOLS.stringCompare, stringCompare(abi)],
    ...x64FloatTextRoutines(abi),
    ...x64HeapRoutines(abi, io),
  ];
  return new Map([
    ...definitions.map(
      ([symbol, define]) =>
        [symbol, { symbol, fn: routine(symbol, registers, define) }] as const,
    ),
    ...x64IoRoutines(io, registers),
  ]);
}
