import { TEXT_UNIT_BYTES } from "../../types/scalar.js";
import {
  ASCII_LIMIT,
  CARRIAGE_RETURN,
  LEAD_SURROGATE,
  LINE_FEED,
  SURROGATE_BITS,
  SURROGATE_MASK,
  SURROGATE_PAYLOAD_MASK,
  SURROGATE_UNITS,
  SUPPLEMENTARY_BASE,
  TEXT_STREAM_BYTES,
  TEXT_TERMINATOR_UNITS,
  TRAIL_SURROGATE,
  UTF8_MOST_BYTES,
  UTF8_SEQUENCES,
  UTF8_TAIL_BITS,
  UTF8_TAIL_MARK,
  UTF8_TAIL_MASK,
  type Utf8Sequence,
} from "../../target/unicode.js";
import {
  asciiData,
  integerData,
  INT32_DECIMAL_BYTES,
  utf16Data,
  zeroFilledBuffer,
} from "../../machine/data.js";
import { imm, mem, type MemoryOperand } from "../../machine/ir.js";
import { routine, type MachineRoutineBuilder } from "../../machine/routine.js";
import type { NativeRuntimeRoutine } from "../../target/artifact.js";
import type { RegisterFile } from "../../target/registers.js";
import { argumentLocations } from "../../target/abi.js";
import type { RegisterClassId } from "../../target/registers.js";
import { FLOAT64_DECIMAL_BYTES } from "../../target/float64.js";
import { X64_FPR, X64_GPR } from "./registers.js";
import { x64IntegerArgumentNames, x64IntegerReturnName } from "./abi.js";
import {
  STANDARD_ERROR_STREAM,
  STANDARD_OUTPUT_STREAM,
  type PlatformIo,
  type ProgramStream,
} from "./entry.js";
import { printTerminatorAt } from "../../metadata/builtin-methods.js";
import { NULL_TEXT } from "../../metadata/printed-values.js";
import {
  TERA_EXIT_UNCAUGHT_THROW,
  TERA_UNCAUGHT_PREFIX,
} from "../../target/faults.js";
import { X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const TERMINATOR_KEY = "x64:terminator";
const UNCAUGHT_PREFIX_KEY = "x64:uncaught-prefix";
const NEWLINE_KEY = "x64:newline";
const DIGITS_KEY = "x64:digits";
const FLOAT_TEXT_KEY = "x64:float-text";
const ABSENT_KEY = "x64:absent-text";
const UTF8_SCRATCH_KEY = "x64:utf8-scratch";
const ASKED_KEY = "x64:asked";
const ASKED_SLOTS = 2;
const SLOT_BYTES = 8;
const DECODE_ROOM = SURROGATE_UNITS + TEXT_TERMINATOR_UNITS;
const TERMINATOR_BYTES = 1;
const SAVED_REGISTERS: readonly string[] = ["rbx", "r12", "r13", "r14", "r15"];
const TERMINATOR = "rbx";
const TEXT = "r12";
const LENGTH = "r13";
const COUNT_REGISTER = "r14";
const SPARE = "r15";
const TRANSFERRED = "rax";
const CODE_POINT = "rax";
const UNIT_SCRATCH = "rcx";
const STREAM_CURSOR = "rdx";
const TRAILING_UNIT = "rdx";

const READ_BLOCK = "read";
const TRIM_BLOCK = "trim";
const TERMINATE_BLOCK = "terminate";
const SILENT_BLOCK = "silent";
const PRESENT_BLOCK = "present";
const DECODE_BLOCK = "decode";
const TAKE_BLOCK = "take";
const EMIT_BLOCK = "emit";
const ENCODE_BLOCK = "encode";
const LOOP_BLOCK = "loop";
const ROOM_BLOCK = "room";
const DONE_BLOCK = "done";
const FLUSHED_BLOCK = "flushed";
const OUTPUT_TAG = "out";
const PROMPT_TAG = "ask";
const FAULT_TAG = "fault";

const widthBlock = (name: string, sequence: Utf8Sequence): string =>
  `${name}${sequence.bytes}`;

function enter(builder: MachineRoutineBuilder, platform: PlatformIo): void {
  for (const name of SAVED_REGISTERS) builder.emit("pushq", builder.read(name, 8));
  if (platform.frameBytes === 0) return;
  builder.emit(
    "subq",
    builder.write(platform.abi.stackPointer.name, 8),
    imm(platform.frameBytes),
  );
}

function leave(builder: MachineRoutineBuilder, platform: PlatformIo): void {
  if (platform.frameBytes !== 0) {
    builder.emit(
      "addq",
      builder.write(platform.abi.stackPointer.name, 8),
      imm(platform.frameBytes),
    );
  }
  for (const name of [...SAVED_REGISTERS].reverse()) {
    builder.emit("popq", builder.write(name, 8));
  }
  builder.ret();
}


function continuationBits(builder: MachineRoutineBuilder, byteAt: () => MemoryOperand): void {
  builder
    .emit("movzbl", builder.write(UNIT_SCRATCH, 4), byteAt())
    .emit("incq", builder.write(STREAM_CURSOR, 8))
    .emit("andl", builder.write(UNIT_SCRATCH, 4), imm(UTF8_TAIL_MASK))
    .emit("shll", builder.write(CODE_POINT, 4), imm(UTF8_TAIL_BITS))
    .emit("orl", builder.write(CODE_POINT, 4), builder.read(UNIT_SCRATCH, 4));
}

function splitSurrogates(builder: MachineRoutineBuilder, unit: () => MemoryOperand): void {
  builder
    .emit("subl", builder.write(CODE_POINT, 4), imm(SUPPLEMENTARY_BASE))
    .emit("movl", builder.write(UNIT_SCRATCH, 4), builder.read(CODE_POINT, 4))
    .emit("shrl", builder.write(UNIT_SCRATCH, 4), imm(SURROGATE_BITS))
    .emit("addl", builder.write(UNIT_SCRATCH, 4), imm(LEAD_SURROGATE))
    .emit("movw", unit(), builder.read(UNIT_SCRATCH, 2))
    .emit("incq", builder.write(SPARE, 8))
    .emit("andl", builder.write(CODE_POINT, 4), imm(SURROGATE_PAYLOAD_MASK))
    .emit("addl", builder.write(CODE_POINT, 4), imm(TRAIL_SURROGATE));
}

function readLine(builder: MachineRoutineBuilder, platform: PlatformIo): void {
  const scratch = builder.data(
    UTF8_SCRATCH_KEY,
    1,
    zeroFilledBuffer(TEXT_STREAM_BYTES),
    true,
  );
  const taken = (displacement: number) =>
    mem(1, {
      base: builder.read(TERMINATOR, 8),
      index: builder.read(COUNT_REGISTER, 8),
      scale: 1,
      displacement,
    });
  const cursor = () =>
    mem(1, {
      base: builder.read(TERMINATOR, 8),
      index: builder.read(STREAM_CURSOR, 8),
      scale: 1,
    });
  const unit = () =>
    mem(TEXT_UNIT_BYTES, {
      base: builder.read(TEXT, 8),
      index: builder.read(SPARE, 8),
      scale: TEXT_UNIT_BYTES,
    });
  builder
    .emit("xorl", builder.write(COUNT_REGISTER, 4), builder.read(COUNT_REGISTER, 4))
    .at(READ_BLOCK)
    .emit("leaq", builder.write(TERMINATOR, 8), mem(1, { symbol: scratch.label }))
    .emit("movl", builder.write(SPARE, 4), builder.read(COUNT_REGISTER, 4))
    .emit("incl", builder.write(SPARE, 4))
    .emit("cmpl", builder.read(SPARE, 4), imm(TEXT_STREAM_BYTES))
    .to("jge", TRIM_BLOCK)
    .emit("leaq", builder.write(SPARE, 8), taken(0));
  platform.read(builder, SPARE, imm(1), TRANSFERRED);
  builder
    .emit("testq", builder.read(TRANSFERRED, 8), builder.read(TRANSFERRED, 8))
    .to("jle", TRIM_BLOCK)
    .emit("leaq", builder.write(TERMINATOR, 8), mem(1, { symbol: scratch.label }))
    .emit("movzbl", builder.write(SPARE, 4), taken(0))
    .emit("cmpl", builder.read(SPARE, 4), imm(LINE_FEED))
    .to("je", TRIM_BLOCK)
    .emit("incq", builder.write(COUNT_REGISTER, 8))
    .to("jmp", READ_BLOCK)
    .at(TRIM_BLOCK)
    .emit("leaq", builder.write(TERMINATOR, 8), mem(1, { symbol: scratch.label }))
    .emit("testq", builder.read(COUNT_REGISTER, 8), builder.read(COUNT_REGISTER, 8))
    .to("jle", DECODE_BLOCK)
    .emit("movzbl", builder.write(SPARE, 4), taken(-1))
    .emit("cmpl", builder.read(SPARE, 4), imm(CARRIAGE_RETURN))
    .to("jne", DECODE_BLOCK)
    .emit("decq", builder.write(COUNT_REGISTER, 8))
    .at(DECODE_BLOCK)
    .emit("xorl", builder.write(STREAM_CURSOR, 4), builder.read(STREAM_CURSOR, 4))
    .emit("xorl", builder.write(SPARE, 4), builder.read(SPARE, 4))
    .at(TAKE_BLOCK)
    .emit("cmpq", builder.read(STREAM_CURSOR, 8), builder.read(COUNT_REGISTER, 8))
    .to("jge", TERMINATE_BLOCK)
    .emit("movl", builder.write(UNIT_SCRATCH, 4), builder.read(SPARE, 4))
    .emit("addl", builder.write(UNIT_SCRATCH, 4), imm(DECODE_ROOM))
    .emit("cmpl", builder.read(UNIT_SCRATCH, 4), builder.read(LENGTH, 4))
    .to("jge", TERMINATE_BLOCK)
    .emit("movzbl", builder.write(CODE_POINT, 4), cursor())
    .emit("incq", builder.write(STREAM_CURSOR, 8))
    .emit("cmpl", builder.read(CODE_POINT, 4), imm(ASCII_LIMIT))
    .to("jl", EMIT_BLOCK);
  for (const [index, sequence] of UTF8_SEQUENCES.entries()) {
    const wider = UTF8_SEQUENCES[index + 1];
    if (index === 0 || wider === undefined) continue;
    builder
      .emit("cmpl", builder.read(CODE_POINT, 4), imm(wider.mark))
      .to("jl", widthBlock(DECODE_BLOCK, sequence));
  }
  const decoded = UTF8_SEQUENCES.slice(1).reverse();
  for (const [index, sequence] of decoded.entries()) {
    if (index > 0) builder.at(widthBlock(DECODE_BLOCK, sequence));
    builder.emit("andl", builder.write(CODE_POINT, 4), imm(sequence.leadMask));
    for (let tail = sequence.tailShifts.length; tail > 0; tail -= 1) {
      continuationBits(builder, cursor);
    }
    if (sequence.limit > SUPPLEMENTARY_BASE) splitSurrogates(builder, unit);
    if (index + 1 < decoded.length) builder.to("jmp", EMIT_BLOCK);
  }
  builder
    .at(EMIT_BLOCK)
    .emit("movw", unit(), builder.read(CODE_POINT, 2))
    .emit("incq", builder.write(SPARE, 8))
    .to("jmp", TAKE_BLOCK)
    .at(TERMINATE_BLOCK)
    .emit("movw", unit(), imm(0));
}

function terminatorSlot(builder: MachineRoutineBuilder): MemoryOperand {
  const datum = builder.data(
    TERMINATOR_KEY,
    TERMINATOR_BYTES,
    zeroFilledBuffer(TERMINATOR_BYTES),
    true,
  );
  return mem(TERMINATOR_BYTES, { symbol: datum.label });
}

function captureTerminator(builder: MachineRoutineBuilder, terminator: string): void {
  builder
    .emit("movl", builder.write(TERMINATOR, 4), builder.read(terminator, 4))
    .emit("movb", terminatorSlot(builder), builder.read(TERMINATOR, 1));
}

function writeTerminator(builder: MachineRoutineBuilder, platform: PlatformIo): void {
  builder
    .emit("movzbl", builder.write(TRANSFERRED, 4), terminatorSlot(builder))
    .emit("testl", builder.read(TRANSFERRED, 4), builder.read(TRANSFERRED, 4))
    .to("je", SILENT_BLOCK)
    .emit("leaq", builder.write(TEXT, 8), terminatorSlot(builder))
    .emit("movl", builder.write(LENGTH, 4), imm(TERMINATOR_BYTES));
  platform.write(builder, TEXT, LENGTH, STANDARD_OUTPUT_STREAM);
  builder.at(SILENT_BLOCK);
}

function putByte(builder: MachineRoutineBuilder): void {
  builder
    .emit("movb", mem(1, { base: builder.read(SPARE, 8) }), builder.read(UNIT_SCRATCH, 1))
    .emit("incq", builder.write(SPARE, 8));
}

function shiftedBits(builder: MachineRoutineBuilder, shift: number): void {
  builder.emit("movl", builder.write(UNIT_SCRATCH, 4), builder.read(CODE_POINT, 4));
  if (shift > 0) builder.emit("shrl", builder.write(UNIT_SCRATCH, 4), imm(shift));
}

function continuationByte(builder: MachineRoutineBuilder, shift: number): void {
  shiftedBits(builder, shift);
  builder
    .emit("andl", builder.write(UNIT_SCRATCH, 4), imm(UTF8_TAIL_MASK))
    .emit("orl", builder.write(UNIT_SCRATCH, 4), imm(UTF8_TAIL_MARK));
  putByte(builder);
}

function leadByte(builder: MachineRoutineBuilder, sequence: Utf8Sequence): void {
  shiftedBits(builder, sequence.leadShift);
  if (sequence.mark > 0) {
    builder.emit("orl", builder.write(UNIT_SCRATCH, 4), imm(sequence.mark));
  }
  putByte(builder);
}

function flushUtf8(
  builder: MachineRoutineBuilder,
  platform: PlatformIo,
  stream: ProgramStream,
): void {
  builder
    .emit("movq", builder.write(LENGTH, 8), builder.read(SPARE, 8))
    .emit("subq", builder.write(LENGTH, 8), builder.read(TEXT, 8));
  platform.write(builder, TEXT, LENGTH, stream);
  builder.emit("movq", builder.write(SPARE, 8), builder.read(TEXT, 8));
}

function writeUtf8(
  builder: MachineRoutineBuilder,
  platform: PlatformIo,
  source: string,
  stream: ProgramStream,
  tag: string,
): void {
  const scratch = builder.data(
    UTF8_SCRATCH_KEY,
    1,
    zeroFilledBuffer(TEXT_STREAM_BYTES),
    true,
  );
  const at = (label: string) => `${tag}_${label}`;
  const taken = () => mem(TEXT_UNIT_BYTES, { base: builder.read(COUNT_REGISTER, 8) });
  builder
    .emit("movq", builder.write(COUNT_REGISTER, 8), builder.read(source, 8))
    .emit("leaq", builder.write(TEXT, 8), mem(1, { symbol: scratch.label }))
    .emit("movq", builder.write(SPARE, 8), builder.read(TEXT, 8))
    .at(at(LOOP_BLOCK))
    .emit("movq", builder.write(CODE_POINT, 8), builder.read(SPARE, 8))
    .emit("subq", builder.write(CODE_POINT, 8), builder.read(TEXT, 8))
    .emit("cmpq", builder.read(CODE_POINT, 8), imm(TEXT_STREAM_BYTES - UTF8_MOST_BYTES))
    .to("jl", at(ROOM_BLOCK));
  flushUtf8(builder, platform, stream);
  builder
    .at(at(ROOM_BLOCK))
    .emit("movzwl", builder.write(CODE_POINT, 4), taken())
    .emit("testl", builder.read(CODE_POINT, 4), builder.read(CODE_POINT, 4))
    .to("je", at(DONE_BLOCK))
    .emit("addq", builder.write(COUNT_REGISTER, 8), imm(TEXT_UNIT_BYTES))
    .emit("movl", builder.write(UNIT_SCRATCH, 4), builder.read(CODE_POINT, 4))
    .emit("andl", builder.write(UNIT_SCRATCH, 4), imm(SURROGATE_MASK))
    .emit("cmpl", builder.read(UNIT_SCRATCH, 4), imm(LEAD_SURROGATE))
    .to("jne", at(ENCODE_BLOCK))
    .emit("movzwl", builder.write(TRAILING_UNIT, 4), taken())
    .emit("movl", builder.write(UNIT_SCRATCH, 4), builder.read(TRAILING_UNIT, 4))
    .emit("andl", builder.write(UNIT_SCRATCH, 4), imm(SURROGATE_MASK))
    .emit("cmpl", builder.read(UNIT_SCRATCH, 4), imm(TRAIL_SURROGATE))
    .to("jne", at(ENCODE_BLOCK))
    .emit("subl", builder.write(CODE_POINT, 4), imm(LEAD_SURROGATE))
    .emit("shll", builder.write(CODE_POINT, 4), imm(SURROGATE_BITS))
    .emit("subl", builder.write(TRAILING_UNIT, 4), imm(TRAIL_SURROGATE))
    .emit("addl", builder.write(CODE_POINT, 4), builder.read(TRAILING_UNIT, 4))
    .emit("addl", builder.write(CODE_POINT, 4), imm(SUPPLEMENTARY_BASE))
    .emit("addq", builder.write(COUNT_REGISTER, 8), imm(TEXT_UNIT_BYTES))
    .at(at(ENCODE_BLOCK));
  for (const [index, sequence] of UTF8_SEQUENCES.entries()) {
    const wider = UTF8_SEQUENCES[index + 1];
    if (index > 0) builder.at(at(widthBlock(ENCODE_BLOCK, sequence)));
    if (wider !== undefined) {
      builder
        .emit("cmpl", builder.read(CODE_POINT, 4), imm(sequence.limit))
        .to("jge", at(widthBlock(ENCODE_BLOCK, wider)));
    }
    leadByte(builder, sequence);
    for (const shift of sequence.tailShifts) continuationByte(builder, shift);
    builder.to("jmp", at(LOOP_BLOCK));
  }
  builder
    .at(at(DONE_BLOCK))
    .emit("movq", builder.write(CODE_POINT, 8), builder.read(SPARE, 8))
    .emit("subq", builder.write(CODE_POINT, 8), builder.read(TEXT, 8))
    .emit("testq", builder.read(CODE_POINT, 8), builder.read(CODE_POINT, 8))
    .to("jle", at(FLUSHED_BLOCK));
  flushUtf8(builder, platform, stream);
  builder.at(at(FLUSHED_BLOCK));
}

function writeLine(builder: MachineRoutineBuilder, platform: PlatformIo): void {
  writeUtf8(builder, platform, TEXT, STANDARD_OUTPUT_STREAM, OUTPUT_TAG);
  writeTerminator(builder, platform);
}

function printString(platform: PlatformIo) {
  const [value, terminator] = x64IntegerArgumentNames(platform.abi);
  return (builder: MachineRoutineBuilder): void => {
    enter(builder, platform);
    const absent = builder.data(ABSENT_KEY, TEXT_UNIT_BYTES, [utf16Data(NULL_TEXT)], false);
    captureTerminator(builder, terminator!);
    builder
      .emit("movq", builder.write(TEXT, 8), builder.read(value!, 8))
      .emit("testq", builder.read(TEXT, 8), builder.read(TEXT, 8))
      .to("jne", PRESENT_BLOCK)
      .emit("leaq", builder.write(TEXT, 8), mem(1, { symbol: absent.label }))
      .at(PRESENT_BLOCK);
    writeLine(builder, platform);
    leave(builder, platform);
  };
}

function printInt(platform: PlatformIo) {
  const [value, terminator, third] = x64IntegerArgumentNames(platform.abi);
  return (builder: MachineRoutineBuilder): void => {
    enter(builder, platform);
    const digits = builder.data(
      DIGITS_KEY,
      1,
      zeroFilledBuffer(INT32_DECIMAL_BYTES * TEXT_UNIT_BYTES),
      true,
    );
    captureTerminator(builder, terminator!);
    builder
      .emit("movl", builder.write(COUNT_REGISTER, 4), builder.read(value!, 4))
      .emit("leaq", builder.write(value!, 8), mem(1, { symbol: digits.label }))
      .emit("movl", builder.write(terminator!, 4), imm(INT32_DECIMAL_BYTES))
      .emit("movl", builder.write(third!, 4), builder.read(COUNT_REGISTER, 4))
      .callSymbol(X64_RUNTIME_SYMBOLS.int32ToString)
      .emit(
        "movq",
        builder.write(TEXT, 8),
        builder.read(x64IntegerReturnName(platform.abi), 8),
      );
    writeLine(builder, platform);
    leave(builder, platform);
  };
}

function floatArgumentMove(
  builder: MachineRoutineBuilder,
  from: string,
  to: string,
): void {
  if (from === to) return;
  builder.emit("movapd", builder.write(to, 8), builder.read(from, 8));
}

function registerNames(
  abi: PlatformIo["abi"],
  classes: readonly RegisterClassId[],
): string[] {
  return argumentLocations(abi.callingConvention, classes).map((location) => {
    if (location.kind !== "register") throw new Error("float printing takes register arguments");
    return location.register.name;
  });
}

function printFloat(platform: PlatformIo) {
  const [value, terminator] = registerNames(platform.abi, [X64_FPR, X64_GPR]);
  const [text, capacity, argument] = registerNames(platform.abi, [X64_GPR, X64_GPR, X64_FPR]);
  return (builder: MachineRoutineBuilder): void => {
    enter(builder, platform);
    const rendered = builder.data(
      FLOAT_TEXT_KEY,
      1,
      zeroFilledBuffer(FLOAT64_DECIMAL_BYTES * TEXT_UNIT_BYTES),
      true,
    );
    captureTerminator(builder, terminator!);
    floatArgumentMove(builder, value!, argument!);
    builder
      .emit("leaq", builder.write(text!, 8), mem(1, { symbol: rendered.label }))
      .emit("movl", builder.write(capacity!, 4), imm(FLOAT64_DECIMAL_BYTES))
      .callSymbol(X64_RUNTIME_SYMBOLS.floatToString)
      .emit(
        "movq",
        builder.write(TEXT, 8),
        builder.read(x64IntegerReturnName(platform.abi), 8),
      );
    writeLine(builder, platform);
    leave(builder, platform);
  };
}

function input(platform: PlatformIo) {
  const [destination, capacity, prompt] = x64IntegerArgumentNames(platform.abi);
  return (builder: MachineRoutineBuilder): void => {
    enter(builder, platform);
    const asked = builder.data(
      ASKED_KEY,
      SLOT_BYTES,
      zeroFilledBuffer(ASKED_SLOTS * SLOT_BYTES),
      true,
    );
    const slot = (index: number) =>
      mem(SLOT_BYTES, { symbol: asked.label, displacement: index * SLOT_BYTES });
    builder
      .emit("movq", slot(0), builder.read(destination!, 8))
      .emit("movq", slot(1), builder.read(capacity!, 8));
    writeUtf8(builder, platform, prompt!, STANDARD_OUTPUT_STREAM, PROMPT_TAG);
    builder
      .emit("movq", builder.write(TEXT, 8), slot(0))
      .emit("movq", builder.write(LENGTH, 8), slot(1));
    readLine(builder, platform);
    builder.emit(
      "movq",
      builder.write(x64IntegerReturnName(platform.abi), 8),
      builder.read(TEXT, 8),
    );
    leave(builder, platform);
  };
}

function throwError(platform: PlatformIo) {
  const [message] = x64IntegerArgumentNames(platform.abi);
  return (builder: MachineRoutineBuilder): void => {
    enter(builder, platform);
    const prefix = builder.data(UNCAUGHT_PREFIX_KEY, 1, [
      asciiData(TERA_UNCAUGHT_PREFIX, false),
    ]);
    const newline = builder.data(NEWLINE_KEY, 1, [
      integerData(printTerminatorAt(0, 1), TERMINATOR_BYTES),
    ]);
    builder
      .emit("movq", builder.write(COUNT_REGISTER, 8), builder.read(message!, 8))
      .emit("leaq", builder.write(TEXT, 8), mem(1, { symbol: prefix.label }))
      .emit("movl", builder.write(LENGTH, 4), imm(TERA_UNCAUGHT_PREFIX.length));
    platform.write(builder, TEXT, LENGTH, STANDARD_ERROR_STREAM);
    writeUtf8(builder, platform, COUNT_REGISTER, STANDARD_ERROR_STREAM, FAULT_TAG);
    builder
      .emit("leaq", builder.write(TEXT, 8), mem(1, { symbol: newline.label }))
      .emit("movl", builder.write(LENGTH, 4), imm(TERMINATOR_BYTES));
    platform.write(builder, TEXT, LENGTH, STANDARD_ERROR_STREAM);
    platform.exit(builder, imm(TERA_EXIT_UNCAUGHT_THROW));
  };
}

const MILLIS = "rax";
const WAITED = "rcx";
const ZERO_MILLIS = "xmm1";
const RESULT_MILLIS = "xmm0";

function clockNow(platform: PlatformIo) {
  return (builder: MachineRoutineBuilder): void => {
    enter(builder, platform);
    platform.now!(builder, MILLIS);
    builder.emit("cvtsi2sdq", builder.write(RESULT_MILLIS, 8), builder.read(MILLIS, 8));
    leave(builder, platform);
    builder.ret();
  };
}

function clockWait(platform: PlatformIo) {
  return (builder: MachineRoutineBuilder): void => {
    enter(builder, platform);
    builder
      .emit("xorpd", builder.write(ZERO_MILLIS, 8), builder.read(ZERO_MILLIS, 8))
      .emit("comisd", builder.read(RESULT_MILLIS, 8), builder.read(ZERO_MILLIS, 8))
      .to("jbe", "done")
      .emit("cvttsd2siq", builder.write(WAITED, 8), builder.read(RESULT_MILLIS, 8));
    platform.wait!(builder, WAITED);
    builder.at("done");
    leave(builder, platform);
    builder.ret();
  };
}

export function x64IoRoutines(
  platform: PlatformIo,
  registers: RegisterFile,
): ReadonlyMap<string, NativeRuntimeRoutine> {
  const definitions: readonly (readonly [
    string,
    (builder: MachineRoutineBuilder) => void,
  ])[] = [
    [X64_RUNTIME_SYMBOLS.printString, printString(platform)],
    [X64_RUNTIME_SYMBOLS.printInt, printInt(platform)],
    [X64_RUNTIME_SYMBOLS.printFloat, printFloat(platform)],
    [X64_RUNTIME_SYMBOLS.input, input(platform)],
    [X64_RUNTIME_SYMBOLS.throwError, throwError(platform)],
    ...(platform.now === undefined || platform.wait === undefined
      ? []
      : ([
          [X64_RUNTIME_SYMBOLS.clock, clockNow(platform)],
          [X64_RUNTIME_SYMBOLS.pause, clockWait(platform)],
        ] as const)),
  ];
  return new Map(
    definitions.map(([symbol, define]) => [
      symbol,
      { symbol, fn: routine(symbol, registers, define) },
    ]),
  );
}
