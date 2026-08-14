import {
  asciiData,
  integerData,
  INT32_DECIMAL_BYTES,
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
} from "./entry.js";
import { printTerminatorAt } from "../../metadata/builtin-methods.js";
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
const TERMINATOR_BYTES = 1;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SAVED_REGISTERS: readonly string[] = ["rbx", "r12", "r13", "r14", "r15"];
const TERMINATOR = "rbx";
const TEXT = "r12";
const LENGTH = "r13";
const COUNT_REGISTER = "r14";
const SPARE = "r15";
const TRANSFERRED = "rax";

const READ_BLOCK = "read";
const TRIM_BLOCK = "trim";
const TERMINATE_BLOCK = "terminate";
const MEASURE_BLOCK = "measure";
const MEASURED_BLOCK = "measured";

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

function measureText(builder: MachineRoutineBuilder, text: string, length: string): void {
  builder
    .emit("movq", builder.write(length, 8), builder.read(text, 8))
    .at(MEASURE_BLOCK)
    .emit("cmpb", mem(1, { base: builder.read(length, 8) }), imm(0))
    .to("je", MEASURED_BLOCK)
    .emit("incq", builder.write(length, 8))
    .to("jmp", MEASURE_BLOCK)
    .at(MEASURED_BLOCK)
    .emit("subq", builder.write(length, 8), builder.read(text, 8));
}

function readLine(builder: MachineRoutineBuilder, platform: PlatformIo): void {
  const at = (displacement: number) =>
    mem(1, {
      base: builder.read(TEXT, 8),
      index: builder.read(COUNT_REGISTER, 8),
      scale: 1,
      displacement,
    });
  builder
    .emit("xorl", builder.write(COUNT_REGISTER, 4), builder.read(COUNT_REGISTER, 4))
    .at(READ_BLOCK)
    .emit("movl", builder.write(SPARE, 4), builder.read(COUNT_REGISTER, 4))
    .emit("incl", builder.write(SPARE, 4))
    .emit("cmpl", builder.read(SPARE, 4), builder.read(LENGTH, 4))
    .to("jge", TRIM_BLOCK)
    .emit("leaq", builder.write(SPARE, 8), at(0));
  platform.read(builder, SPARE, imm(1), TRANSFERRED);
  builder
    .emit("testq", builder.read(TRANSFERRED, 8), builder.read(TRANSFERRED, 8))
    .to("jle", TRIM_BLOCK)
    .emit("movzbl", builder.write(SPARE, 4), at(0))
    .emit("cmpl", builder.read(SPARE, 4), imm(LINE_FEED))
    .to("je", TRIM_BLOCK)
    .emit("incq", builder.write(COUNT_REGISTER, 8))
    .to("jmp", READ_BLOCK)
    .at(TRIM_BLOCK)
    .emit("testq", builder.read(COUNT_REGISTER, 8), builder.read(COUNT_REGISTER, 8))
    .to("jle", TERMINATE_BLOCK)
    .emit("movzbl", builder.write(SPARE, 4), at(-1))
    .emit("cmpl", builder.read(SPARE, 4), imm(CARRIAGE_RETURN))
    .to("jne", TERMINATE_BLOCK)
    .emit("decq", builder.write(COUNT_REGISTER, 8))
    .at(TERMINATE_BLOCK)
    .emit("movb", at(0), imm(0));
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
    .emit("leaq", builder.write(TEXT, 8), terminatorSlot(builder))
    .emit("movl", builder.write(LENGTH, 4), imm(TERMINATOR_BYTES));
  platform.write(builder, TEXT, LENGTH, STANDARD_OUTPUT_STREAM);
}

function writeLine(builder: MachineRoutineBuilder, platform: PlatformIo): void {
  measureText(builder, TEXT, LENGTH);
  platform.write(builder, TEXT, LENGTH, STANDARD_OUTPUT_STREAM);
  writeTerminator(builder, platform);
}

function printString(platform: PlatformIo) {
  const [value, terminator] = x64IntegerArgumentNames(platform.abi);
  return (builder: MachineRoutineBuilder): void => {
    enter(builder, platform);
    captureTerminator(builder, terminator!);
    builder.emit("movq", builder.write(TEXT, 8), builder.read(value!, 8));
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
      zeroFilledBuffer(INT32_DECIMAL_BYTES),
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
      zeroFilledBuffer(FLOAT64_DECIMAL_BYTES),
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
    builder
      .emit("movq", builder.write(COUNT_REGISTER, 8), builder.read(destination!, 8))
      .emit("movl", builder.write(LENGTH, 4), builder.read(capacity!, 4))
      .emit("movq", builder.write(TEXT, 8), builder.read(prompt!, 8));
    measureText(builder, TEXT, SPARE);
    platform.write(builder, TEXT, SPARE, STANDARD_OUTPUT_STREAM);
    builder.emit("movq", builder.write(TEXT, 8), builder.read(COUNT_REGISTER, 8));
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
    builder.emit("movq", builder.write(TEXT, 8), builder.read(COUNT_REGISTER, 8));
    measureText(builder, TEXT, LENGTH);
    platform.write(builder, TEXT, LENGTH, STANDARD_ERROR_STREAM);
    builder
      .emit("leaq", builder.write(TEXT, 8), mem(1, { symbol: newline.label }))
      .emit("movl", builder.write(LENGTH, 4), imm(TERMINATOR_BYTES));
    platform.write(builder, TEXT, LENGTH, STANDARD_ERROR_STREAM);
    platform.exit(builder, imm(TERA_EXIT_UNCAUGHT_THROW));
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
  ];
  return new Map(
    definitions.map(([symbol, define]) => [
      symbol,
      { symbol, fn: routine(symbol, registers, define) },
    ]),
  );
}
