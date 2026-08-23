import { alignUp } from "../../mc/buffer.js";
import { importAddressSymbol, type PeImportLibrary } from "../../mc/formats/pe.js";
import { zeroFilledBuffer } from "../../machine/data.js";
import {
  imm,
  mem,
  type MachineFunction,
  type MachineOperand,
  type MemoryOperand,
} from "../../machine/ir.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
import type { RuntimeAbi } from "../../target/abi.js";
import { withoutThreadEntryPoints } from "../../target/runtime-layout.js";
import {
  WINDOWS_MEM_COMMIT,
  WINDOWS_MEM_RESERVE,
  WINDOWS_PAGE_READWRITE,
} from "../../target/syscalls.js";
import type { ProgramEntryShape } from "../../target/entry.js";
import type { RegisterFile } from "../../target/registers.js";
import { x64IntegerArgumentNames, x64IntegerReturnName } from "./abi.js";
import {
  STANDARD_ERROR_STREAM,
  STANDARD_OUTPUT_STREAM,
  x64Entry,
  type PlatformIo,
  type ProgramStream,
} from "./entry.js";

export const WINDOWS_PROGRAM_ENTRY = "_start";

const KERNEL32_DLL = "kernel32.dll";

const KERNEL32 = {
  standardHandle: "GetStdHandle",
  read: "ReadFile",
  write: "WriteFile",
  exit: "ExitProcess",
  allocate: "VirtualAlloc",
  ticks: "GetTickCount64",
  pause: "Sleep",
} as const;

const VIRTUAL_ALLOC_ANY_ADDRESS = 0;

export const WINDOWS_IMPORTS: readonly PeImportLibrary[] = [
  { dll: KERNEL32_DLL, functions: withoutThreadEntryPoints(Object.values(KERNEL32)) },
];

const STANDARD_INPUT = -10;

const STANDARD_STREAMS = new Map<ProgramStream, number>([
  [STANDARD_OUTPUT_STREAM, -11],
  [STANDARD_ERROR_STREAM, -12],
]);
const FILE_CALL_ARGUMENTS = 5;
const TRANSFERRED_KEY = "win64:transferred";
const TRANSFERRED_BYTES = 4;
const HANDLE_REGISTER = "rbx";

function frameBytesOf(abi: RuntimeAbi): number {
  const convention = abi.callingConvention;
  const stacked = Math.max(0, FILE_CALL_ARGUMENTS - x64IntegerArgumentNames(abi).length);
  return alignUp(
    convention.shadowSpaceBytes + stacked * convention.stackArgumentSlotBytes,
    abi.stackAlignmentBytes,
  );
}

function importedCall(abi: RuntimeAbi, name: string): MemoryOperand {
  return mem(abi.pointerWidthBytes, { symbol: importAddressSymbol(name) });
}

function transferredSlot(builder: MachineRoutineBuilder): MemoryOperand {
  const datum = builder.data(
    TRANSFERRED_KEY,
    TRANSFERRED_BYTES,
    zeroFilledBuffer(TRANSFERRED_BYTES),
    true,
  );
  return mem(TRANSFERRED_BYTES, { symbol: datum.label });
}

function overlappedSlot(builder: MachineRoutineBuilder, abi: RuntimeAbi): MemoryOperand {
  return mem(abi.pointerWidthBytes, {
    base: builder.read(abi.stackPointer.name, 8),
    displacement: abi.callingConvention.shadowSpaceBytes,
  });
}

function takeStandardHandle(
  builder: MachineRoutineBuilder,
  abi: RuntimeAbi,
  stream: number,
): void {
  const [first] = x64IntegerArgumentNames(abi);
  builder
    .emit("movl", builder.write(first!, 4), imm(stream))
    .callThrough(importedCall(abi, KERNEL32.standardHandle))
    .emit(
      "movq",
      builder.write(HANDLE_REGISTER, 8),
      builder.read(x64IntegerReturnName(abi), 8),
    );
}

function transferBytes(
  builder: MachineRoutineBuilder,
  abi: RuntimeAbi,
  operation: string,
): void {
  const [first, , , fourth] = x64IntegerArgumentNames(abi);
  builder
    .emit("movl", transferredSlot(builder), imm(0))
    .emit("movq", builder.write(first!, 8), builder.read(HANDLE_REGISTER, 8))
    .emit("leaq", builder.write(fourth!, 8), transferredSlot(builder))
    .emit("movq", overlappedSlot(builder, abi), imm(0))
    .callThrough(importedCall(abi, operation));
}

function virtualAlloc(
  builder: MachineRoutineBuilder,
  abi: RuntimeAbi,
  address: MachineOperand,
  bytes: string,
  action: number,
): void {
  const [first, second, third, fourth] = x64IntegerArgumentNames(abi);
  builder
    .emit("movq", builder.write(first!, 8), address)
    .emit("movq", builder.write(second!, 8), builder.read(bytes, 8))
    .emit("movl", builder.write(third!, 4), imm(action))
    .emit("movl", builder.write(fourth!, 4), imm(WINDOWS_PAGE_READWRITE))
    .callThrough(importedCall(abi, KERNEL32.allocate));
}

export function windowsIo(abi: RuntimeAbi): PlatformIo {
  const [first, second, third] = x64IntegerArgumentNames(abi);
  return {
    abi,
    frameBytes: frameBytesOf(abi),
    reserve: (builder, bytes, base) => {
      virtualAlloc(builder, abi, imm(VIRTUAL_ALLOC_ANY_ADDRESS), bytes, WINDOWS_MEM_RESERVE);
      builder.emit(
        "movq",
        builder.write(base, 8),
        builder.read(x64IntegerReturnName(abi), 8),
      );
    },
    commit: (builder, base, bytes, status) => {
      virtualAlloc(builder, abi, builder.read(base, 8), bytes, WINDOWS_MEM_COMMIT);
      builder.emit(
        "movq",
        builder.write(status, 8),
        builder.read(x64IntegerReturnName(abi), 8),
      );
    },
    read: (builder, buffer, bytes, count) => {
      takeStandardHandle(builder, abi, STANDARD_INPUT);
      builder
        .emit("movq", builder.write(second!, 8), builder.read(buffer, 8))
        .emit("movl", builder.write(third!, 4), bytes);
      transferBytes(builder, abi, KERNEL32.read);
      builder.emit("movl", builder.write(count, 4), transferredSlot(builder));
    },
    write: (builder, text, length, stream) => {
      takeStandardHandle(builder, abi, STANDARD_STREAMS.get(stream)!);
      builder
        .emit("movq", builder.write(second!, 8), builder.read(text, 8))
        .emit("movl", builder.write(third!, 4), builder.read(length, 4));
      transferBytes(builder, abi, KERNEL32.write);
    },
    now: (builder, millis) => {
      builder
        .callThrough(importedCall(abi, KERNEL32.ticks))
        .emit("movq", builder.write(millis, 8), builder.read(x64IntegerReturnName(abi), 8));
    },
    wait: (builder, millis) => {
      builder
        .emit("movl", builder.write(first!, 4), builder.read(millis, 4))
        .callThrough(importedCall(abi, KERNEL32.pause));
    },
    exit: (builder, status: MachineOperand) => {
      builder
        .emit("movl", builder.write(first!, 4), status)
        .callThrough(importedCall(abi, KERNEL32.exit));
    },
  };
}

export function windowsProgramEntry(
  callee: string,
  shape: ProgramEntryShape,
  io: PlatformIo,
  registers: RegisterFile,
): MachineFunction {
  return x64Entry(WINDOWS_PROGRAM_ENTRY, callee, shape, io, registers);
}
