import { imm, mem } from "../../machine/ir.js";
import { asciiData } from "../../machine/data.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
import {
  ARRAY_ELEMENTS_OFFSET,
  ARRAY_LENGTH_OFFSET,
  BUFFER_ELEMENTS_OFFSET,
} from "../../metadata/class-table.js";
import {
  AGGREGATE_CLOSE_TEXT,
  AGGREGATE_OPEN_TEXT,
  AGGREGATE_SEPARATOR_TEXT,
  NO_TERMINATOR,
} from "../../metadata/builtin-methods.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
  scalarWidth,
  type AotScalar,
} from "../../types/scalar.js";
import { x64IntegerArgumentNames } from "./abi.js";
import type { PlatformIo } from "./entry.js";
import { X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const SAVED: readonly string[] = ["rbx", "r12", "r13", "r14", "r15"];

const LENGTH = "rbx";
const INDEX = "r12";
const TERMINATOR = "r13";
const ELEMENTS = "r14";

const PRINTERS = new Map<AotScalar, string>([
  [SCALAR_INT32, X64_RUNTIME_SYMBOLS.printInt],
  [SCALAR_FLOAT64, X64_RUNTIME_SYMBOLS.printFloat],
  [SCALAR_STRING, X64_RUNTIME_SYMBOLS.printString],
]);

export const ARRAY_PRINT_SYMBOLS = new Map<AotScalar, string>([
  [SCALAR_INT32, "tera_x64_print_array_i32"],
  [SCALAR_FLOAT64, "tera_x64_print_array_f64"],
  [SCALAR_STRING, "tera_x64_print_array_str"],
]);

function enter(builder: MachineRoutineBuilder, platform: PlatformIo): void {
  for (const name of SAVED) builder.emit("pushq", builder.read(name, 8));
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
  for (const name of [...SAVED].reverse()) builder.emit("popq", builder.write(name, 8));
  builder.ret();
}

function terminatorRegister(platform: PlatformIo, floating: boolean): string {
  const names = x64IntegerArgumentNames(platform.abi);
  const shared = platform.abi.callingConvention.sharedArgumentPositions;
  if (!floating) return names[1]!;
  return shared ? names[1]! : names[0]!;
}

function printText(
  builder: MachineRoutineBuilder,
  platform: PlatformIo,
  text: string,
  terminator: string | number,
): void {
  const names = x64IntegerArgumentNames(platform.abi);
  const datum = builder.data(`aggregate:${text}`, 1, [asciiData(text)], false);
  builder.emit("leaq", builder.write(names[0]!, 8), mem(8, { symbol: datum.label }));
  if (typeof terminator === "number") {
    builder.emit("movl", builder.write(names[1]!, 4), imm(terminator));
  } else {
    builder.emit("movl", builder.write(names[1]!, 4), builder.read(terminator, 4));
  }
  builder.callSymbol(X64_RUNTIME_SYMBOLS.printString);
}

export function x64ArrayPrintRoutine(platform: PlatformIo, element: AotScalar) {
  const printer = PRINTERS.get(element)!;
  const width = scalarWidth(element);
  const floating = element === SCALAR_FLOAT64;
  return (builder: MachineRoutineBuilder): void => {
    const names = x64IntegerArgumentNames(platform.abi);
    const [array, terminator] = names;
    enter(builder, platform);
    builder
      .emit("movq", builder.write(ELEMENTS, 8), builder.read(array!, 8))
      .emit("movl", builder.write(TERMINATOR, 4), builder.read(terminator!, 4))
      .emit(
        "movl",
        builder.write(LENGTH, 4),
        mem(4, { base: builder.read(ELEMENTS, 8), displacement: ARRAY_LENGTH_OFFSET }),
      )
      .emit(
        "movq",
        builder.write(ELEMENTS, 8),
        mem(8, { base: builder.read(ELEMENTS, 8), displacement: ARRAY_ELEMENTS_OFFSET }),
      )
      .emit("addq", builder.write(ELEMENTS, 8), imm(BUFFER_ELEMENTS_OFFSET));
    printText(builder, platform, AGGREGATE_OPEN_TEXT, NO_TERMINATOR);
    builder
      .emit("xorl", builder.write(INDEX, 4), builder.read(INDEX, 4))
      .at("step")
      .emit("cmpl", builder.read(INDEX, 4), builder.read(LENGTH, 4))
      .to("jge", "close")
      .emit("testl", builder.read(INDEX, 4), builder.read(INDEX, 4))
      .to("je", "value");
    printText(builder, platform, AGGREGATE_SEPARATOR_TEXT, NO_TERMINATOR);
    builder.at("value");
    const slot = mem(width, {
      base: builder.read(ELEMENTS, 8),
      index: builder.read(INDEX, 8),
      scale: width,
    });
    if (floating) builder.emit("movsd", builder.write("xmm0", 8), slot);
    else builder.emit(width === 8 ? "movq" : "movl", builder.write(names[0]!, width), slot);
    builder
      .emit("movl", builder.write(terminatorRegister(platform, floating), 4), imm(NO_TERMINATOR))
      .callSymbol(printer)
      .emit("incl", builder.write(INDEX, 4))
      .to("jmp", "step")
      .at("close");
    printText(builder, platform, AGGREGATE_CLOSE_TEXT, TERMINATOR);
    leave(builder, platform);
  };
}
