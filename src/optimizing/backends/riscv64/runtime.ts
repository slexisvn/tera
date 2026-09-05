import type { RuntimeAbi } from "../../target/abi.js";
import type { NativeRuntimeRoutine } from "../../target/artifact.js";
import type { RegisterFile } from "../../target/registers.js";
import {
  asciiData,
  integerData,
  INT32_DECIMAL_BYTES,
  zeroFilledBuffer,
} from "../../machine/data.js";
import { imm, mem, sym, type MachineFunction } from "../../machine/ir.js";
import { routine, type MachineRoutineBuilder } from "../../machine/routine.js";
import { NativeBackendError } from "../../machine/backend.js";
import type { ProgramEntryShape } from "../../target/entry.js";
import {
  RISCV_PROGRAM_ENTRY,
  RISCV_RUNTIME_SYMBOLS,
} from "./runtime-symbols.js";
import { riscvFloatTextRoutines } from "./float-text.js";
import { riscvHeapRoutines } from "./heap.js";
import { printTerminatorAt } from "../../metadata/builtin-methods.js";
import { FLOAT64_DECIMAL_BYTES } from "../../target/float64.js";
import {
  TERA_ALLOC_SYMBOL,
  TERA_POINTER_BYTES,
} from "../../target/runtime-layout.js";
import { INT32_MIN } from "../../target/integer.js";
import { RISCV64_LINUX_SYSCALLS } from "../../target/syscalls.js";
import {
  CHAR_DIGIT_ZERO,
  CHAR_MINUS_SIGN,
  DECIMAL_RADIX,
} from "../../target/text.js";
import {
  FLOAT64_EXPONENT_BIAS,
  FLOAT64_EXPONENT_MASK,
  FLOAT64_MANTISSA_BITS,
} from "../../target/float64.js";
import {
  TERA_EXIT_HEAP_EXHAUSTED,
  TERA_EXIT_UNCAUGHT_THROW,
  TERA_TEXT_OVERFLOW,
  TERA_UNCAUGHT_PREFIX,
} from "../../target/faults.js";



const WORD = TERA_POINTER_BYTES;
const DIGIT_ZERO = CHAR_DIGIT_ZERO;
const MINUS_SIGN = CHAR_MINUS_SIGN;
const RADIX = DECIMAL_RADIX;
const MANTISSA_BITS = FLOAT64_MANTISSA_BITS;
const EXPONENT_MASK = FLOAT64_EXPONENT_MASK;
const EXPONENT_BIAS = FLOAT64_EXPONENT_BIAS;
const LINUX_EXIT = RISCV64_LINUX_SYSCALLS.exit;

function toInt32(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .emit("fmv.x.d", w("t0"), r("fa0"))
    .emit("srli", w("t1"), r("t0"), imm(MANTISSA_BITS))
    .emit("andi", w("t1"), r("t1"), imm(EXPONENT_MASK))
    .emit("addi", w("t1"), r("t1"), imm(-EXPONENT_BIAS))
    .emit("li", w("t2"), imm(32))
    .to("bge", "zero", r("t1"), r("t2"))
    .emit("slli", w("t3"), r("t0"), imm(12))
    .emit("srli", w("t3"), r("t3"), imm(12))
    .emit("li", w("t4"), imm(1))
    .emit("slli", w("t4"), r("t4"), imm(MANTISSA_BITS))
    .emit("or", w("t3"), r("t3"), r("t4"))
    .to("bltz", "right", r("t1"))
    .emit("sll", w("t3"), r("t3"), r("t1"))
    .to("j", "sign")
    .at("right")
    .emit("sub", w("t2"), r("zero"), r("t1"))
    .emit("li", w("t4"), imm(64))
    .to("bge", "zero", r("t2"), r("t4"))
    .emit("srl", w("t3"), r("t3"), r("t2"))
    .at("sign")
    .emit("sext.w", w("a0"), r("t3"))
    .to("bgez", "done", r("t0"))
    .emit("subw", w("a0"), r("zero"), r("a0"))
    .at("done")
    .ret()
    .at("zero")
    .emit("li", w("a0"), imm(0))
    .ret();
}

function divide(remainder: boolean) {
  return (builder: MachineRoutineBuilder): void => {
    const r = (name: string) => builder.read(name, WORD);
    const w = (name: string) => builder.write(name, WORD);
    builder
      .to("beqz", "zero", r("a1"))
      .emit("li", w("t0"), imm(-1))
      .to("bne", "divide", r("a1"), r("t0"))
      .emit("li", w("t1"), imm(INT32_MIN))
      .to("beq", "zero", r("a0"), r("t1"))
      .at("divide")
      .emit(remainder ? "remw" : "divw", w("a0"), r("a0"), r("a1"))
      .ret()
      .at("zero")
      .emit("li", w("a0"), imm(0))
      .ret();
  };
}

function extremum(first: string, second: string) {
  return (builder: MachineRoutineBuilder): void => {
    const r = (name: string) => builder.read(name, WORD);
    const w = (name: string) => builder.write(name, WORD);
    builder
      .emit("feq.d", w("t0"), r("fa0"), r("fa0"))
      .to("beqz", "nan", r("t0"))
      .emit("feq.d", w("t0"), r("fa1"), r("fa1"))
      .to("beqz", "nan", r("t0"))
      .emit("flt.d", w("t0"), r(first), r(second))
      .to("bnez", "done", r("t0"))
      .emit("fmv.d", w("fa0"), r("fa1"))
      .at("done")
      .ret()
      .at("nan")
      .emit("fsub.d", w("fa0"), r("fa0"), r("fa0"))
      .emit("fsub.d", w("fa1"), r("fa1"), r("fa1"))
      .emit("fadd.d", w("fa0"), r("fa0"), r("fa1"))
      .ret();
  };
}

function charCodeAt(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .to("bltz", "zero", r("a1"))
    .emit("add", w("t0"), r("a0"), r("a1"))
    .emit("lbu", w("a0"), mem(1, { base: r("t0") }))
    .ret()
    .at("zero")
    .emit("li", w("a0"), imm(0))
    .ret();
}

const TEXT_OVERFLOW_KEY = "text-overflow";

function reportTextOverflow(builder: MachineRoutineBuilder): void {
  const text = builder.data(TEXT_OVERFLOW_KEY, 1, [asciiData(TERA_TEXT_OVERFLOW)]);
  builder
    .emit("lla", builder.write("a0", WORD), sym(text.label))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.throwError);
}

function copy(append: boolean) {
  return (builder: MachineRoutineBuilder): void => {
    const r = (name: string) => builder.read(name, WORD);
    const w = (name: string) => builder.write(name, WORD);
    builder
      .to("blez", "done", r("a1"))
      .emit("mv", w("t0"), r("a0"))
      .emit("addiw", w("t1"), r("a1"), imm(-1));
    if (append) {
      builder
        .at("seek")
        .to("blez", "overflow", r("t1"))
        .emit("lbu", w("t2"), mem(1, { base: r("t0") }))
        .to("beqz", "copy", r("t2"))
        .emit("addi", w("t0"), r("t0"), imm(1))
        .emit("addiw", w("t1"), r("t1"), imm(-1))
        .to("j", "seek");
    }
    builder
      .at("copy")
      .to("blez", "overflow", r("t1"))
      .emit("lbu", w("t2"), mem(1, { base: r("a2") }))
      .to("beqz", "terminate", r("t2"))
      .emit("sb", r("t2"), mem(1, { base: r("t0") }))
      .emit("addi", w("t0"), r("t0"), imm(1))
      .emit("addi", w("a2"), r("a2"), imm(1))
      .emit("addiw", w("t1"), r("t1"), imm(-1))
      .to("j", "copy")
      .at("overflow")
      .emit("lbu", w("t2"), mem(1, { base: r("a2") }))
      .to("beqz", "terminate", r("t2"));
    reportTextOverflow(builder);
    builder
      .at("terminate")
      .emit("sb", r("zero"), mem(1, { base: r("t0") }))
      .at("done")
      .ret();
  };
}

function charAt(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .emit("li", w("t0"), imm(2))
    .to("blt", "empty", r("a1"), r("t0"))
    .to("bltz", "empty", r("a3"))
    .emit("mv", w("t1"), r("a3"))
    .emit("mv", w("t2"), r("a2"))
    .at("walk")
    .to("beqz", "at", r("t1"))
    .emit("lbu", w("t3"), mem(1, { base: r("t2") }))
    .to("beqz", "empty", r("t3"))
    .emit("addi", w("t2"), r("t2"), imm(1))
    .emit("addi", w("t1"), r("t1"), imm(-1))
    .to("j", "walk")
    .at("at")
    .emit("lbu", w("t3"), mem(1, { base: r("t2") }))
    .to("beqz", "empty", r("t3"))
    .emit("sb", r("t3"), mem(1, { base: r("a0") }))
    .emit("sb", r("zero"), mem(1, { base: r("a0"), displacement: 1 }))
    .ret()
    .at("empty")
    .to("blez", "done", r("a1"))
    .emit("sb", r("zero"), mem(1, { base: r("a0") }))
    .at("done")
    .ret();
}

function int32ToString(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .emit("li", w("t0"), imm(INT32_DECIMAL_BYTES))
    .to("blt", "empty", r("a1"), r("t0"))
    .emit("mv", w("t0"), r("a0"))
    .emit("sext.w", w("t1"), r("a2"))
    .to("bgez", "digits", r("t1"))
    .emit("li", w("t2"), imm(MINUS_SIGN))
    .emit("sb", r("t2"), mem(1, { base: r("t0") }))
    .emit("addi", w("t0"), r("t0"), imm(1))
    .emit("sub", w("t1"), r("zero"), r("t1"))
    .at("digits")
    .emit("mv", w("t2"), r("t0"))
    .emit("li", w("t3"), imm(RADIX))
    .at("divide")
    .emit("remu", w("t4"), r("t1"), r("t3"))
    .emit("divu", w("t1"), r("t1"), r("t3"))
    .emit("addi", w("t4"), r("t4"), imm(DIGIT_ZERO))
    .emit("sb", r("t4"), mem(1, { base: r("t0") }))
    .emit("addi", w("t0"), r("t0"), imm(1))
    .to("bnez", "divide", r("t1"))
    .emit("sb", r("zero"), mem(1, { base: r("t0") }))
    .emit("addi", w("t5"), r("t0"), imm(-1))
    .at("reverse")
    .to("bgeu", "done", r("t2"), r("t5"))
    .emit("lbu", w("t6"), mem(1, { base: r("t2") }))
    .emit("lbu", w("t4"), mem(1, { base: r("t5") }))
    .emit("sb", r("t4"), mem(1, { base: r("t2") }))
    .emit("sb", r("t6"), mem(1, { base: r("t5") }))
    .emit("addi", w("t2"), r("t2"), imm(1))
    .emit("addi", w("t5"), r("t5"), imm(-1))
    .to("j", "reverse")
    .at("empty")
    .to("blez", "done", r("a1"))
    .emit("sb", r("zero"), mem(1, { base: r("a0") }))
    .at("done")
    .ret();
}

function stringCompare(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .at("scan")
    .emit("lbu", w("t0"), mem(1, { base: r("a0") }))
    .emit("lbu", w("t1"), mem(1, { base: r("a1") }))
    .to("bne", "differ", r("t0"), r("t1"))
    .to("beqz", "same", r("t0"))
    .emit("addi", w("a0"), r("a0"), imm(1))
    .emit("addi", w("a1"), r("a1"), imm(1))
    .to("j", "scan")
    .at("differ")
    .emit("sub", w("a0"), r("t0"), r("t1"))
    .ret()
    .at("same")
    .emit("li", w("a0"), imm(0))
    .ret();
}

function stringLength(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .emit("mv", w("t0"), r("a0"))
    .at("scan")
    .emit("lbu", w("t1"), mem(1, { base: r("t0") }))
    .to("beqz", "done", r("t1"))
    .emit("addi", w("t0"), r("t0"), imm(1))
    .to("j", "scan")
    .at("done")
    .emit("sub", w("a0"), r("t0"), r("a0"))
    .ret();
}

function rounding(mode: string) {
  return (builder: MachineRoutineBuilder): void => {
    const r = (name: string) => builder.read(name, WORD);
    const w = (name: string) => builder.write(name, WORD);
    builder
      .emit("fmv.x.d", w("t0"), r("fa0"))
      .emit("slli", w("t1"), r("t0"), imm(1))
      .emit("srli", w("t1"), r("t1"), imm(53))
      .emit("li", w("t2"), imm(EXPONENT_BIAS))
      .to("bge", "done", r("t1"), r("t2"))
      .emit("fcvt.l.d", w("t3"), r("fa0"), sym(mode))
      .emit("fcvt.d.l", w("ft0"), r("t3"))
      .emit("fsgnj.d", w("fa0"), r("ft0"), r("fa0"))
      .at("done")
      .ret();
  };
}

const LINUX_READ = 63;
const LINUX_WRITE = 64;
const STDIN = 0;
const STDOUT = 1;
const UNCAUGHT_PREFIX_KEY = "rv64:uncaught-prefix";
const STDERR = 2;
const TERMINATOR_KEY = "rv64:terminator";
const TERMINATOR_BYTES = 1;
const DIGITS_KEY = "rv64:digits";
const FLOAT_TEXT_KEY = "rv64:float-text";
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const RETURN_SLOT = 16;

function measureText(
  builder: MachineRoutineBuilder,
  text: string,
  length: string,
  scratch: string,
  block: string,
): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .emit("mv", w(length), r(text))
    .at(block)
    .emit("lbu", w(scratch), mem(1, { base: r(length) }))
    .to("beqz", `${block}.done`, r(scratch))
    .emit("addi", w(length), r(length), imm(1))
    .to("j", block)
    .at(`${block}.done`)
    .emit("sub", w(length), r(length), r(text));
}

function writeBytes(
  builder: MachineRoutineBuilder,
  text: string,
  length: string,
  stream = STDOUT,
): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .emit("mv", w("a1"), r(text))
    .emit("mv", w("a2"), r(length))
    .emit("li", w("a0"), imm(stream))
    .emit("li", w("a7"), imm(LINUX_WRITE))
    .emit("ecall");
}

function captureTerminator(
  builder: MachineRoutineBuilder,
  terminator: string,
  scratch: string,
): void {
  const slot = builder.data(TERMINATOR_KEY, 1, zeroFilledBuffer(TERMINATOR_BYTES), true);
  builder
    .emit("lla", builder.write(scratch, WORD), sym(slot.label))
    .emit(
      "sb",
      builder.read(terminator, 1),
      mem(1, { base: builder.read(scratch, WORD) }),
    );
}

function writeTerminator(builder: MachineRoutineBuilder): void {
  const slot = builder.data(TERMINATOR_KEY, 1, zeroFilledBuffer(TERMINATOR_BYTES), true);
  builder
    .emit("lla", builder.write("t0", WORD), sym(slot.label))
    .emit("li", builder.write("t1", WORD), imm(TERMINATOR_BYTES));
  writeBytes(builder, "t0", "t1");
}

function writeLine(builder: MachineRoutineBuilder, text: string, block: string): void {
  measureText(builder, text, "t1", "t2", block);
  writeBytes(builder, text, "t1");
  writeTerminator(builder);
}

function printString(builder: MachineRoutineBuilder): void {
  captureTerminator(builder, "a1", "t0");
  builder.emit("mv", builder.write("t0", WORD), builder.read("a0", WORD));
  writeLine(builder, "t0", "measure");
  builder.ret();
}

function printInt(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  const digits = builder.data(DIGITS_KEY, 1, zeroFilledBuffer(INT32_DECIMAL_BYTES), true);
  captureTerminator(builder, "a1", "t0");
  builder
    .emit("addi", w("sp"), r("sp"), imm(-RETURN_SLOT))
    .emit("sd", r("ra"), mem(WORD, { base: r("sp") }))
    .emit("mv", w("a2"), r("a0"))
    .emit("lla", w("a0"), sym(digits.label))
    .emit("li", w("a1"), imm(INT32_DECIMAL_BYTES))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.int32ToString)
    .emit("mv", w("t0"), r("a0"));
  writeLine(builder, "t0", "measure");
  builder
    .emit("ld", w("ra"), mem(WORD, { base: r("sp") }))
    .emit("addi", w("sp"), r("sp"), imm(RETURN_SLOT))
    .ret();
}

function input(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  builder
    .emit("mv", w("t0"), r("a0"))
    .emit("mv", w("t1"), r("a1"))
    .emit("mv", w("t2"), r("a2"));
  measureText(builder, "t2", "t3", "t4", "prompt");
  writeBytes(builder, "t2", "t3");
  builder
    .emit("li", w("t3"), imm(0))
    .at("read")
    .emit("addi", w("t4"), r("t3"), imm(1))
    .to("bge", "trim", r("t4"), r("t1"))
    .emit("add", w("t5"), r("t0"), r("t3"))
    .emit("mv", w("a1"), r("t5"))
    .emit("li", w("a2"), imm(1))
    .emit("li", w("a0"), imm(STDIN))
    .emit("li", w("a7"), imm(LINUX_READ))
    .emit("ecall")
    .to("blez", "trim", r("a0"))
    .emit("lbu", w("t6"), mem(1, { base: r("t5") }))
    .emit("li", w("t4"), imm(LINE_FEED))
    .to("beq", "trim", r("t6"), r("t4"))
    .emit("addi", w("t3"), r("t3"), imm(1))
    .to("j", "read")
    .at("trim")
    .to("blez", "terminate", r("t3"))
    .emit("add", w("t5"), r("t0"), r("t3"))
    .emit("lbu", w("t6"), mem(1, { base: r("t5"), displacement: -1 }))
    .emit("li", w("t4"), imm(CARRIAGE_RETURN))
    .to("bne", "terminate", r("t6"), r("t4"))
    .emit("addi", w("t3"), r("t3"), imm(-1))
    .at("terminate")
    .emit("add", w("t5"), r("t0"), r("t3"))
    .emit("sb", r("zero"), mem(1, { base: r("t5") }))
    .emit("mv", w("a0"), r("t0"))
    .ret();
}

function printFloat(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  const rendered = builder.data(
    FLOAT_TEXT_KEY,
    1,
    zeroFilledBuffer(FLOAT64_DECIMAL_BYTES),
    true,
  );
  captureTerminator(builder, "a0", "t0");
  builder
    .emit("addi", w("sp"), r("sp"), imm(-RETURN_SLOT))
    .emit("sd", r("ra"), mem(WORD, { base: r("sp") }))
    .emit("lla", w("a0"), sym(rendered.label))
    .emit("li", w("a1"), imm(FLOAT64_DECIMAL_BYTES))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.floatToString)
    .emit("mv", w("t0"), r("a0"));
  writeLine(builder, "t0", "measure");
  builder
    .emit("ld", w("ra"), mem(WORD, { base: r("sp") }))
    .emit("addi", w("sp"), r("sp"), imm(RETURN_SLOT))
    .ret();
}

function throwError(builder: MachineRoutineBuilder): void {
  const r = (name: string) => builder.read(name, WORD);
  const w = (name: string) => builder.write(name, WORD);
  const prefix = builder.data(UNCAUGHT_PREFIX_KEY, 1, [
    asciiData(TERA_UNCAUGHT_PREFIX, false),
  ]);
  const newline = builder.data(TERMINATOR_KEY, 1, [
    integerData(printTerminatorAt(0, 1), TERMINATOR_BYTES),
  ]);
  builder
    .emit("mv", w("t3"), r("a0"))
    .emit("lla", w("t0"), sym(prefix.label))
    .emit("li", w("t1"), imm(TERA_UNCAUGHT_PREFIX.length));
  writeBytes(builder, "t0", "t1", STDERR);
  measureText(builder, "t3", "t1", "t2", "message");
  writeBytes(builder, "t3", "t1", STDERR);
  builder
    .emit("lla", w("t0"), sym(newline.label))
    .emit("li", w("t1"), imm(TERMINATOR_BYTES));
  writeBytes(builder, "t0", "t1", STDERR);
  builder
    .emit("li", w("a0"), imm(TERA_EXIT_UNCAUGHT_THROW))
    .emit("li", w("a7"), imm(LINUX_EXIT))
    .emit("ecall");
}

export function riscvProgramEntry(
  callee: string,
  shape: ProgramEntryShape,
  registers: RegisterFile,
): MachineFunction {
  if (shape.delivery !== "exit") {
    throw new NativeBackendError("riscv64", "an entry result can only be an exit status");
  }
  return routine(RISCV_PROGRAM_ENTRY, registers, (builder) => {
    builder
      .callSymbol(RISCV_RUNTIME_SYMBOLS.reserve)
      .callSymbol(callee)
      .emit("li", builder.write("a7", WORD), imm(LINUX_EXIT))
      .emit("ecall");
  });
}

export function riscvRuntimeRoutines(
  registers: RegisterFile,
  abi: RuntimeAbi,
): ReadonlyMap<string, NativeRuntimeRoutine> {
  const definitions: readonly (readonly [
    string,
    (builder: MachineRoutineBuilder) => void,
  ])[] = [
    [RISCV_RUNTIME_SYMBOLS.toInt32, toInt32],
    [RISCV_RUNTIME_SYMBOLS.divide, divide(false)],
    [RISCV_RUNTIME_SYMBOLS.modulo, divide(true)],
    [RISCV_RUNTIME_SYMBOLS.minimum, extremum("fa0", "fa1")],
    [RISCV_RUNTIME_SYMBOLS.maximum, extremum("fa1", "fa0")],
    [RISCV_RUNTIME_SYMBOLS.charCodeAt, charCodeAt],
    [RISCV_RUNTIME_SYMBOLS.stringSet, copy(false)],
    [RISCV_RUNTIME_SYMBOLS.stringAppend, copy(true)],
    [RISCV_RUNTIME_SYMBOLS.charAt, charAt],
    [RISCV_RUNTIME_SYMBOLS.int32ToString, int32ToString],
    [RISCV_RUNTIME_SYMBOLS.stringLength, stringLength],
    [RISCV_RUNTIME_SYMBOLS.stringCompare, stringCompare],
    [RISCV_RUNTIME_SYMBOLS.floor, rounding("rdn")],
    [RISCV_RUNTIME_SYMBOLS.ceil, rounding("rup")],
    [RISCV_RUNTIME_SYMBOLS.trunc, rounding("rtz")],
    [RISCV_RUNTIME_SYMBOLS.printString, printString],
    [RISCV_RUNTIME_SYMBOLS.printInt, printInt],
    [RISCV_RUNTIME_SYMBOLS.input, input],
    [RISCV_RUNTIME_SYMBOLS.throwError, throwError],
    [RISCV_RUNTIME_SYMBOLS.printFloat, printFloat],
    ...riscvFloatTextRoutines(),
    ...riscvHeapRoutines(abi),
  ];
  return new Map(
    definitions.map(([symbol, define]) => [
      symbol,
      { symbol, fn: routine(symbol, registers, define) },
    ]),
  );
}
