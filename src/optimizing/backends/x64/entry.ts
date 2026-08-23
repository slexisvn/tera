import { imm, type MachineFunction, type MachineOperand } from "../../machine/ir.js";
import { routine, type MachineRoutineBuilder } from "../../machine/routine.js";
import type { RegisterFile } from "../../target/registers.js";
import type { RuntimeAbi } from "../../target/abi.js";
import type { ProgramEntryShape } from "../../target/entry.js";
import { printTerminatorAt } from "../../metadata/builtin-methods.js";
import { x64IntegerArgumentNames, x64IntegerReturnName } from "./abi.js";
import { X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const SUCCESS = 0;

export const STANDARD_OUTPUT_STREAM = "output";
export const STANDARD_ERROR_STREAM = "error";

export type ProgramStream =
  | typeof STANDARD_OUTPUT_STREAM
  | typeof STANDARD_ERROR_STREAM;

export interface PlatformIo {
  readonly abi: RuntimeAbi;
  readonly frameBytes: number;
  reserve(builder: MachineRoutineBuilder, bytes: string, base: string): void;
  commit(
    builder: MachineRoutineBuilder,
    base: string,
    bytes: string,
    status: string,
  ): void;
  read(
    builder: MachineRoutineBuilder,
    buffer: string,
    bytes: MachineOperand,
    count: string,
  ): void;
  write(
    builder: MachineRoutineBuilder,
    text: string,
    length: string,
    stream: ProgramStream,
  ): void;
  exit(builder: MachineRoutineBuilder, status: MachineOperand): void;
  now?(builder: MachineRoutineBuilder, millis: string): void;
  wait?(builder: MachineRoutineBuilder, millis: string): void;
}

function printResult(
  builder: MachineRoutineBuilder,
  platform: PlatformIo,
  shape: ProgramEntryShape,
): void {
  const [first, second] = x64IntegerArgumentNames(platform.abi);
  const returned = x64IntegerReturnName(platform.abi);
  const width = shape.result === "int" ? 4 : 8;
  const onlyValue = 0;
  builder
    .emit(width === 4 ? "movl" : "movq", builder.write(first!, width), builder.read(returned, width))
    .emit("movl", builder.write(second!, 4), imm(printTerminatorAt(onlyValue, 1)))
    .callSymbol(
      shape.result === "int" ? X64_RUNTIME_SYMBOLS.printInt : X64_RUNTIME_SYMBOLS.printString,
    );
}

export function x64Entry(
  symbol: string,
  callee: string,
  shape: ProgramEntryShape,
  platform: PlatformIo,
  registers: RegisterFile,
): MachineFunction {
  return routine(symbol, registers, (builder) => {
    const stack = platform.abi.stackPointer.name;
    builder.emit("andq", builder.write(stack, 8), imm(-platform.abi.stackAlignmentBytes));
    if (platform.frameBytes !== 0) {
      builder.emit("subq", builder.write(stack, 8), imm(platform.frameBytes));
    }
    builder.callSymbol(X64_RUNTIME_SYMBOLS.reserve);
    builder.callSymbol(callee);
    if (shape.delivery === "exit") {
      platform.exit(builder, builder.read(x64IntegerReturnName(platform.abi), 4));
      return;
    }
    printResult(builder, platform, shape);
    platform.exit(builder, imm(SUCCESS));
  });
}
