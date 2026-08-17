import { asciiData, INT32_DECIMAL_BYTES, zeroFilledBuffer } from "../../machine/data.js";
import { imm, mem, type MemoryOperand, type RegisterOperand } from "../../machine/ir.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
import { argumentLocations, type RuntimeAbi } from "../../target/abi.js";
import {
  FLOAT64_BIGNUM_BYTES,
  FLOAT64_BIGNUM_LENGTH_BYTES,
  FLOAT64_DECIMAL_BYTES,
  FLOAT64_EXPONENT_BIAS,
  FLOAT64_EXPONENT_MASK,
  FLOAT64_FIXED_EXPONENT_LIMIT,
  FLOAT64_FRACTION_EXPONENT_LIMIT,
  FLOAT64_LIMB_BITS,
  FLOAT64_LIMB_BYTES,
  FLOAT64_MANTISSA_BITS,
  FLOAT64_MANTISSA_MASK,
  FLOAT64_MIN_EXPONENT,
  FLOAT64_SIGN_SHIFT,
  FLOAT64_SIGNIFICANT_DIGITS,
} from "../../target/float64.js";
import {
  ALL_FLAGS,
  BIGNUM_NAMES,
  DECIMAL_POINT,
  DIGIT_ZERO,
  EXPONENT_MARK,
  floatTextKeys,
  HIGH_FLAG,
  INCLUSIVE_FLAG,
  INFINITY_TEXT,
  LOW_FLAG,
  MINUS_SIGN,
  NEGATIVE_FLAG,
  NEGATIVE_INFINITY_TEXT,
  NOT_A_NUMBER_TEXT,
  PLUS_SIGN,
  RADIX,
  STATE_BYTES,
  STATE_DESTINATION,
  STATE_DIVISOR_SHIFT,
  STATE_POSITIVE_EXPONENT,
  STATE_REMAINDER_SHIFT,
  STATE_STEP,
  TERMINATOR,
  type BignumName,
} from "../../target/float-text-spec.js";
import { X64_FPR, X64_GPR } from "./registers.js";
import { x64IntegerArgumentNames } from "./abi.js";
import { X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const CURSOR = "rbx";
const DECIMAL = "r12";
const COUNT = "r13";
const FLAGS = "r14";
const DIGIT = "r15";
const SAVED: readonly string[] = [CURSOR, DECIMAL, COUNT, FLAGS, DIGIT];

const BIGNUM_KEYS = BIGNUM_NAMES;

const KEYS = floatTextKeys("x64");
const STATE_KEY = KEYS.state;
const DIGITS_KEY = KEYS.digits;
const EXPONENT_KEY = KEYS.exponent;
const NOT_A_NUMBER_KEY = KEYS.notANumber;
const INFINITY_KEY = KEYS.infinity;
const NEGATIVE_INFINITY_KEY = KEYS.negativeInfinity;

const bignumKey = KEYS.bignum;

function limb(base: string, index: string, builder: MachineRoutineBuilder): MemoryOperand {
  return mem(FLOAT64_LIMB_BYTES, {
    base: builder.read(base, 8),
    index: builder.read(index, 8),
    scale: FLOAT64_LIMB_BYTES,
    displacement: FLOAT64_BIGNUM_LENGTH_BYTES,
  });
}

function length(base: string, builder: MachineRoutineBuilder): MemoryOperand {
  return mem(8, { base: builder.read(base, 8) });
}

function reader(builder: MachineRoutineBuilder) {
  return (name: string, width = 8): RegisterOperand => builder.read(name, width);
}

function writer(builder: MachineRoutineBuilder) {
  return (name: string, width = 4): RegisterOperand => builder.write(name, width);
}

function bignumSet(abi: RuntimeAbi) {
  const [pointer, value] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("movq", w("r11", 8), r(pointer!))
      .emit("xorl", w("rax"), r("rax", 4))
      .emit("movq", w("rcx", 8), r(value!))
      .at("scan")
      .emit("testq", r("rcx"), r("rcx"))
      .to("je", "done")
      .emit("movl", limb("r11", "rax", builder), r("rcx", 4))
      .emit("incq", w("rax", 8))
      .emit("shrq", w("rcx", 8), imm(FLOAT64_LIMB_BITS))
      .to("jmp", "scan")
      .at("done")
      .emit("movq", length("r11", builder), r("rax"))
      .ret();
  };
}

function bignumCopy(abi: RuntimeAbi) {
  const [destination, source] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("movq", w("r10", 8), r(destination!))
      .emit("movq", w("r11", 8), r(source!))
      .emit("movq", w("rax", 8), length("r11", builder))
      .emit("movq", length("r10", builder), r("rax"))
      .emit("xorl", w("rcx"), r("rcx", 4))
      .at("scan")
      .emit("cmpq", r("rcx"), r("rax"))
      .to("jae", "done")
      .emit("movl", w("rdx"), limb("r11", "rcx", builder))
      .emit("movl", limb("r10", "rcx", builder), r("rdx", 4))
      .emit("incq", w("rcx", 8))
      .to("jmp", "scan")
      .at("done")
      .ret();
  };
}

function bignumMultiply(abi: RuntimeAbi) {
  const [pointer, factor] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("movq", w("r11", 8), r(pointer!))
      .emit("movl", w("r9"), r(factor!, 4))
      .emit("movq", w("r8", 8), length("r11", builder))
      .emit("xorl", w("r10"), r("r10", 4))
      .emit("xorl", w("rcx"), r("rcx", 4))
      .at("scan")
      .emit("cmpq", r("rcx"), r("r8"))
      .to("jae", "carry")
      .emit("movl", w("rax"), limb("r11", "rcx", builder))
      .emit("imulq", w("rax", 8), r("r9"))
      .emit("addq", w("rax", 8), r("r10"))
      .emit("movl", limb("r11", "rcx", builder), r("rax", 4))
      .emit("movq", w("r10", 8), r("rax"))
      .emit("shrq", w("r10", 8), imm(FLOAT64_LIMB_BITS))
      .emit("incq", w("rcx", 8))
      .to("jmp", "scan")
      .at("carry")
      .emit("testq", r("r10"), r("r10"))
      .to("je", "done")
      .emit("movl", limb("r11", "r8", builder), r("r10", 4))
      .emit("incq", w("r8", 8))
      .emit("shrq", w("r10", 8), imm(FLOAT64_LIMB_BITS))
      .to("jmp", "carry")
      .at("done")
      .emit("movq", length("r11", builder), r("r8"))
      .ret();
  };
}

function bignumShift(abi: RuntimeAbi) {
  const [pointer, bits] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("movq", w("r11", 8), r(pointer!))
      .emit("movq", w("r8", 8), length("r11", builder))
      .emit("testq", r("r8"), r("r8"))
      .to("je", "done")
      .emit("movl", w("rcx"), r(bits!, 4))
      .emit("movl", w("rax"), r("rcx", 4))
      .emit("shrl", w("rax"), imm(Math.log2(FLOAT64_LIMB_BITS)))
      .emit("andl", w("rcx"), imm(FLOAT64_LIMB_BITS - 1))
      .emit("xorl", w("r9"), r("r9", 4))
      .emit("xorl", w("r10"), r("r10", 4))
      .emit("testl", r("rcx", 4), r("rcx", 4))
      .to("je", "words")
      .at("bits")
      .emit("cmpq", r("r10"), r("r8"))
      .to("jae", "spill")
      .emit("movl", w("rdx"), limb("r11", "r10", builder))
      .emit("shlq", w("rdx", 8), r("rcx", 1))
      .emit("orq", w("rdx", 8), r("r9"))
      .emit("movl", limb("r11", "r10", builder), r("rdx", 4))
      .emit("movq", w("r9", 8), r("rdx"))
      .emit("shrq", w("r9", 8), imm(FLOAT64_LIMB_BITS))
      .emit("incq", w("r10", 8))
      .to("jmp", "bits")
      .at("spill")
      .emit("testq", r("r9"), r("r9"))
      .to("je", "words")
      .emit("movl", limb("r11", "r8", builder), r("r9", 4))
      .emit("incq", w("r8", 8))
      .at("words")
      .emit("testl", r("rax", 4), r("rax", 4))
      .to("je", "store")
      .emit("movq", w("r10", 8), r("r8"))
      .emit("decq", w("r10", 8))
      .at("move")
      .emit("testq", r("r10"), r("r10"))
      .to("js", "clear")
      .emit("movl", w("rdx"), limb("r11", "r10", builder))
      .emit("leaq", w("r9", 8), mem(8, { base: r("r10"), index: r("rax"), scale: 1 }))
      .emit("movl", limb("r11", "r9", builder), r("rdx", 4))
      .emit("decq", w("r10", 8))
      .to("jmp", "move")
      .at("clear")
      .emit("xorl", w("r10"), r("r10", 4))
      .at("zero")
      .emit("cmpq", r("r10"), r("rax"))
      .to("jae", "grow")
      .emit("movl", limb("r11", "r10", builder), imm(0))
      .emit("incq", w("r10", 8))
      .to("jmp", "zero")
      .at("grow")
      .emit("addq", w("r8", 8), r("rax"))
      .at("store")
      .emit("movq", length("r11", builder), r("r8"))
      .at("done")
      .ret();
  };
}

function bignumCompare(abi: RuntimeAbi) {
  const [left, right] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("movq", w("r10", 8), r(left!))
      .emit("movq", w("r11", 8), r(right!))
      .emit("movq", w("rax", 8), length("r10", builder))
      .emit("movq", w("rcx", 8), length("r11", builder))
      .emit("cmpq", r("rax"), r("rcx"))
      .to("jb", "below")
      .to("ja", "above")
      .emit("movq", w("r8", 8), r("rax"))
      .at("scan")
      .emit("testq", r("r8"), r("r8"))
      .to("je", "equal")
      .emit("decq", w("r8", 8))
      .emit("movl", w("rdx"), limb("r10", "r8", builder))
      .emit("movl", w("r9"), limb("r11", "r8", builder))
      .emit("cmpl", r("rdx", 4), r("r9", 4))
      .to("jb", "below")
      .to("ja", "above")
      .to("jmp", "scan")
      .at("equal")
      .emit("xorl", w("rax"), r("rax", 4))
      .ret()
      .at("below")
      .emit("movl", w("rax"), imm(-1))
      .ret()
      .at("above")
      .emit("movl", w("rax"), imm(1))
      .ret();
  };
}

function bignumSubtract(abi: RuntimeAbi) {
  const [left, right] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("pushq", r("rbx"))
      .emit("movq", w("r10", 8), r(left!))
      .emit("movq", w("r11", 8), r(right!))
      .emit("movq", w("r8", 8), length("r10", builder))
      .emit("movq", w("r9", 8), length("r11", builder))
      .emit("xorl", w("rcx"), r("rcx", 4))
      .emit("xorl", w("rbx"), r("rbx", 4))
      .at("scan")
      .emit("cmpq", r("rcx"), r("r8"))
      .to("jae", "trim")
      .emit("xorl", w("rdx"), r("rdx", 4))
      .emit("cmpq", r("rcx"), r("r9"))
      .to("jae", "taken")
      .emit("movl", w("rdx"), limb("r11", "rcx", builder))
      .at("taken")
      .emit("addq", w("rdx", 8), r("rbx"))
      .emit("movl", w("rax"), limb("r10", "rcx", builder))
      .emit("xorl", w("rbx"), r("rbx", 4))
      .emit("cmpq", r("rax"), r("rdx"))
      .to("jae", "borrowed")
      .emit("movl", w("rbx"), imm(1))
      .at("borrowed")
      .emit("subq", w("rax", 8), r("rdx"))
      .emit("movl", limb("r10", "rcx", builder), r("rax", 4))
      .emit("incq", w("rcx", 8))
      .to("jmp", "scan")
      .at("trim")
      .emit("testq", r("r8"), r("r8"))
      .to("je", "store")
      .emit(
        "movl",
        w("rdx"),
        mem(FLOAT64_LIMB_BYTES, {
          base: r("r10"),
          index: r("r8"),
          scale: FLOAT64_LIMB_BYTES,
          displacement: FLOAT64_BIGNUM_LENGTH_BYTES - FLOAT64_LIMB_BYTES,
        }),
      )
      .emit("testl", r("rdx", 4), r("rdx", 4))
      .to("jne", "store")
      .emit("decq", w("r8", 8))
      .to("jmp", "trim")
      .at("store")
      .emit("movq", length("r10", builder), r("r8"))
      .emit("popq", w("rbx", 8))
      .ret();
  };
}

function bignumAdd(abi: RuntimeAbi) {
  const [destination, left, right] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("pushq", r("rbx"))
      .emit("pushq", r("r12"))
      .emit("pushq", r("r13"))
      .emit("movq", w("rbx", 8), r(destination!))
      .emit("movq", w("r10", 8), r(left!))
      .emit("movq", w("r11", 8), r(right!))
      .emit("movq", w("r8", 8), length("r10", builder))
      .emit("movq", w("r9", 8), length("r11", builder))
      .emit("movq", w("rcx", 8), r("r8"))
      .emit("cmpq", r("rcx"), r("r9"))
      .to("jae", "widest")
      .emit("movq", w("rcx", 8), r("r9"))
      .at("widest")
      .emit("xorl", w("r12"), r("r12", 4))
      .emit("xorl", w("r13"), r("r13", 4))
      .at("scan")
      .emit("cmpq", r("r12"), r("rcx"))
      .to("jae", "carry")
      .emit("xorl", w("rax"), r("rax", 4))
      .emit("cmpq", r("r12"), r("r8"))
      .to("jae", "right")
      .emit("movl", w("rax"), limb("r10", "r12", builder))
      .at("right")
      .emit("xorl", w("rdx"), r("rdx", 4))
      .emit("cmpq", r("r12"), r("r9"))
      .to("jae", "sum")
      .emit("movl", w("rdx"), limb("r11", "r12", builder))
      .at("sum")
      .emit("addq", w("rax", 8), r("rdx"))
      .emit("addq", w("rax", 8), r("r13"))
      .emit("movl", limb("rbx", "r12", builder), r("rax", 4))
      .emit("movq", w("r13", 8), r("rax"))
      .emit("shrq", w("r13", 8), imm(FLOAT64_LIMB_BITS))
      .emit("incq", w("r12", 8))
      .to("jmp", "scan")
      .at("carry")
      .emit("testq", r("r13"), r("r13"))
      .to("je", "store")
      .emit("movl", limb("rbx", "rcx", builder), r("r13", 4))
      .emit("incq", w("rcx", 8))
      .at("store")
      .emit("movq", length("rbx", builder), r("rcx"))
      .emit("popq", w("r13", 8))
      .emit("popq", w("r12", 8))
      .emit("popq", w("rbx", 8))
      .ret();
  };
}

interface DriverContext {
  readonly builder: MachineRoutineBuilder;
  readonly abi: RuntimeAbi;
  readonly r: (name: string, width?: number) => RegisterOperand;
  readonly w: (name: string, width?: number) => RegisterOperand;
  address(name: BignumName, register: string): void;
  call(symbol: string, load: readonly ((destination: string) => void)[]): void;
  state(offset: number, width: number): MemoryOperand;
}

function driverContext(builder: MachineRoutineBuilder, abi: RuntimeAbi): DriverContext {
  const r = reader(builder);
  const w = writer(builder);
  const names = x64IntegerArgumentNames(abi);
  return {
    builder,
    abi,
    r,
    w,
    address: (name, register) => {
      const datum = builder.data(
        bignumKey(name),
        FLOAT64_BIGNUM_LENGTH_BYTES,
        zeroFilledBuffer(FLOAT64_BIGNUM_BYTES),
        true,
      );
      builder.emit("leaq", w(register, 8), mem(8, { symbol: datum.label }));
    },
    call: (symbol, load) => {
      load.forEach((set, index) => set(names[index]!));
      builder.callSymbol(symbol);
    },
    state: (offset, width) => {
      const datum = builder.data(
        STATE_KEY,
        FLOAT64_BIGNUM_LENGTH_BYTES,
        zeroFilledBuffer(STATE_BYTES),
        true,
      );
      return mem(width, { symbol: datum.label, displacement: offset });
    },
  };
}

function bignumArgument(context: DriverContext, name: BignumName) {
  return (destination: string): void => context.address(name, destination);
}

function immediateArgument(context: DriverContext, value: number) {
  return (destination: string): void => {
    context.builder.emit("movl", context.w(destination), imm(value));
  };
}

function registerArgument(context: DriverContext, source: string) {
  return (destination: string): void => {
    context.builder.emit("movq", context.w(destination, 8), context.r(source));
  };
}

function stateArgument(context: DriverContext, offset: number) {
  return (destination: string): void => {
    context.builder.emit("movl", context.w(destination), context.state(offset, 4));
  };
}

function multiplyByRadix(context: DriverContext, name: BignumName): void {
  context.call(X64_RUNTIME_SYMBOLS.bignumMultiply, [
    bignumArgument(context, name),
    immediateArgument(context, RADIX),
  ]);
}

function compare(context: DriverContext, left: BignumName, right: BignumName): void {
  context.call(X64_RUNTIME_SYMBOLS.bignumCompare, [
    bignumArgument(context, left),
    bignumArgument(context, right),
  ]);
}

function branchWhenAbove(context: DriverContext, target: string): void {
  const { builder, r } = context;
  builder
    .emit("testl", r("rax", 4), r("rax", 4))
    .to("jg", target)
    .to("jne", `${target}.below`)
    .emit("testl", r(FLAGS, 4), imm(INCLUSIVE_FLAG))
    .to("jne", target)
    .at(`${target}.below`);
}

function copyText(context: DriverContext, key: string, text: string, block: string): void {
  const { builder, r, w } = context;
  const datum = builder.data(key, 1, [asciiData(text)]);
  builder
    .emit("leaq", w("r8", 8), mem(1, { symbol: datum.label }))
    .at(block)
    .emit("movzbl", w("rax"), mem(1, { base: r("r8") }))
    .emit("testl", r("rax", 4), r("rax", 4))
    .to("je", `${block}.done`)
    .emit("movb", mem(1, { base: r(CURSOR) }), r("rax", 1))
    .emit("incq", w(CURSOR, 8))
    .emit("incq", w("r8", 8))
    .to("jmp", block)
    .at(`${block}.done`);
}

function digitsAddress(context: DriverContext, register: string): void {
  const datum = context.builder.data(
    DIGITS_KEY,
    1,
    zeroFilledBuffer(FLOAT64_SIGNIFICANT_DIGITS),
    true,
  );
  context.builder.emit("leaq", context.w(register, 8), mem(1, { symbol: datum.label }));
}

function copyDigits(
  context: DriverContext,
  from: RegisterOperand,
  to: string,
  block: string,
): void {
  const { builder, r, w } = context;
  digitsAddress(context, "r8");
  builder
    .emit("movq", w("r9", 8), from)
    .at(block)
    .emit("cmpq", r("r9"), r(to))
    .to("jge", `${block}.done`)
    .emit("movzbl", w("rax"), mem(1, { base: r("r8"), index: r("r9"), scale: 1 }))
    .emit("movb", mem(1, { base: r(CURSOR) }), r("rax", 1))
    .emit("incq", w(CURSOR, 8))
    .emit("incq", w("r9", 8))
    .to("jmp", block)
    .at(`${block}.done`);
}

function writeByte(context: DriverContext, value: number): void {
  context.builder
    .emit("movb", mem(1, { base: context.r(CURSOR) }), imm(value))
    .emit("incq", context.w(CURSOR, 8));
}

function padWith(context: DriverContext, value: number, count: string, block: string): void {
  const { builder, r, w } = context;
  builder.at(block).emit("testq", r(count), r(count)).to("jle", `${block}.done`);
  writeByte(context, value);
  builder.emit("decq", w(count, 8)).to("jmp", block).at(`${block}.done`);
}

function shadowBytes(abi: RuntimeAbi): number {
  const { shadowSpaceBytes } = abi.callingConvention;
  const alignment = abi.stackAlignmentBytes;
  return Math.ceil(shadowSpaceBytes / alignment) * alignment;
}

function decodeArguments(abi: RuntimeAbi): { destination: string; capacity: string; value: string } {
  const locations = argumentLocations(abi.callingConvention, [X64_GPR, X64_GPR, X64_FPR]);
  const named = locations.map((location) => {
    if (location.kind !== "register") throw new Error("float text takes register arguments");
    return location.register.name;
  });
  return { destination: named[0]!, capacity: named[1]!, value: named[2]! };
}

function emitDecode(context: DriverContext, abi: RuntimeAbi): void {
  const { builder, r, w } = context;
  const { destination, capacity, value } = decodeArguments(abi);
  const frame = shadowBytes(abi);

  for (const name of SAVED) builder.emit("pushq", r(name));
  if (frame !== 0) builder.emit("subq", w(abi.stackPointer.name, 8), imm(frame));
  builder
    .emit("movq", w(CURSOR, 8), r(destination))
    .emit("movq", context.state(STATE_DESTINATION, 8), r(CURSOR))
    .emit("cmpl", r(capacity, 4), imm(FLOAT64_DECIMAL_BYTES))
    .to("jge", "decode")
    .emit("testl", r(capacity, 4), r(capacity, 4))
    .to("jle", "return")
    .emit("movb", mem(1, { base: r(CURSOR) }), imm(TERMINATOR))
    .to("jmp", "return")
    .at("decode")
    .emit("movq", w(DIGIT, 8), r(value))
    .emit("movq", w("rax", 8), r(DIGIT))
    .emit("shrq", w("rax", 8), imm(FLOAT64_SIGN_SHIFT))
    .emit("movl", w(FLAGS), r("rax", 4))
    .emit("movq", w("rcx", 8), r(DIGIT))
    .emit("shrq", w("rcx", 8), imm(FLOAT64_MANTISSA_BITS))
    .emit("andl", w("rcx"), imm(FLOAT64_EXPONENT_MASK))
    .emit("movabsq", w("rdx", 8), imm(FLOAT64_MANTISSA_MASK))
    .emit("andq", w(DIGIT, 8), r("rdx"))
    .emit("cmpl", r("rcx", 4), imm(FLOAT64_EXPONENT_MASK))
    .to("jne", "finite")
    .emit("testq", r(DIGIT), r(DIGIT))
    .to("jne", "notANumber")
    .emit("testl", r(FLAGS, 4), imm(NEGATIVE_FLAG))
    .to("jne", "negativeInfinity");
  copyText(context, INFINITY_KEY, INFINITY_TEXT, "infinity");
  builder.to("jmp", "terminate").at("notANumber");
  copyText(context, NOT_A_NUMBER_KEY, NOT_A_NUMBER_TEXT, "notANumber.text");
  builder.to("jmp", "terminate").at("negativeInfinity");
  copyText(context, NEGATIVE_INFINITY_KEY, NEGATIVE_INFINITY_TEXT, "negativeInfinity.text");
  builder
    .to("jmp", "terminate")
    .at("finite")
    .emit("testl", r("rcx", 4), r("rcx", 4))
    .to("jne", "normal")
    .emit("testq", r(DIGIT), r(DIGIT))
    .to("jne", "subnormal");
  writeByte(context, DIGIT_ZERO);
  builder
    .to("jmp", "terminate")
    .at("subnormal")
    .emit("movl", w("r8"), imm(FLOAT64_MIN_EXPONENT))
    .to("jmp", "decoded")
    .at("normal")
    .emit("movabsq", w("rdx", 8), imm(1n << BigInt(FLOAT64_MANTISSA_BITS)))
    .emit("orq", w(DIGIT, 8), r("rdx"))
    .emit("movl", w("r8"), r("rcx", 4))
    .emit("subl", w("r8"), imm(FLOAT64_EXPONENT_BIAS))
    .at("decoded")
    .emit("movl", w("rax"), r(DIGIT, 4))
    .emit("andl", w("rax"), imm(1))
    .emit("xorl", w("rax"), imm(1))
    .emit("addl", w("rax"), r("rax", 4))
    .emit("orl", w(FLAGS), r("rax", 4))
    .emit("movl", w("rdx"), imm(1))
    .emit("movabsq", w("rax", 8), imm(1n << BigInt(FLOAT64_MANTISSA_BITS)))
    .emit("cmpq", r(DIGIT), r("rax"))
    .to("jne", "step")
    .emit("cmpl", r("rcx", 4), imm(1))
    .to("jle", "step")
    .emit("movl", w("rdx"), imm(2))
    .at("step")
    .emit("xorl", w("rax"), r("rax", 4))
    .emit("xorl", w("r9"), r("r9", 4))
    .emit("testl", r("r8", 4), r("r8", 4))
    .to("jle", "negativeExponent")
    .emit("movl", w("rax"), r("r8", 4))
    .to("jmp", "shifts")
    .at("negativeExponent")
    .emit("movl", w("r9"), r("r8", 4))
    .emit("negl", w("r9"))
    .at("shifts")
    .emit("movl", w("r11"), r("rax", 4))
    .emit("addl", w("r11"), r("rdx", 4))
    .emit("movl", context.state(STATE_REMAINDER_SHIFT, 4), r("r11", 4))
    .emit("movl", w("r11"), r("r9", 4))
    .emit("addl", w("r11"), r("rdx", 4))
    .emit("movl", context.state(STATE_DIVISOR_SHIFT, 4), r("r11", 4))
    .emit("movl", context.state(STATE_POSITIVE_EXPONENT, 4), r("rax", 4))
    .emit("movl", context.state(STATE_STEP, 4), r("rdx", 4));
}

function emitSetup(context: DriverContext): void {
  context.call(X64_RUNTIME_SYMBOLS.bignumSet, [
    bignumArgument(context, "remainder"),
    registerArgument(context, DIGIT),
  ]);
  context.call(X64_RUNTIME_SYMBOLS.bignumShift, [
    bignumArgument(context, "remainder"),
    stateArgument(context, STATE_REMAINDER_SHIFT),
  ]);
  context.call(X64_RUNTIME_SYMBOLS.bignumSet, [
    bignumArgument(context, "divisor"),
    immediateArgument(context, 1),
  ]);
  context.call(X64_RUNTIME_SYMBOLS.bignumShift, [
    bignumArgument(context, "divisor"),
    stateArgument(context, STATE_DIVISOR_SHIFT),
  ]);
  context.call(X64_RUNTIME_SYMBOLS.bignumSet, [
    bignumArgument(context, "below"),
    immediateArgument(context, 1),
  ]);
  context.call(X64_RUNTIME_SYMBOLS.bignumShift, [
    bignumArgument(context, "below"),
    stateArgument(context, STATE_POSITIVE_EXPONENT),
  ]);
  context.call(X64_RUNTIME_SYMBOLS.bignumSet, [
    bignumArgument(context, "above"),
    stateArgument(context, STATE_STEP),
  ]);
  context.call(X64_RUNTIME_SYMBOLS.bignumShift, [
    bignumArgument(context, "above"),
    stateArgument(context, STATE_POSITIVE_EXPONENT),
  ]);
}

function emitScale(context: DriverContext): void {
  const { builder, r, w } = context;
  builder.emit("xorl", w(DECIMAL), r(DECIMAL, 4));
  context.call(X64_RUNTIME_SYMBOLS.bignumAdd, [
    bignumArgument(context, "scratch"),
    bignumArgument(context, "remainder"),
    bignumArgument(context, "above"),
  ]);
  builder.at("up");
  compare(context, "scratch", "divisor");
  branchWhenAbove(context, "up.more");
  builder.to("jmp", "down").at("up.more");
  multiplyByRadix(context, "divisor");
  builder.emit("incq", w(DECIMAL, 8)).to("jmp", "up").at("down");
  multiplyByRadix(context, "scratch");
  compare(context, "scratch", "divisor");
  branchWhenAbove(context, "generate");
  multiplyByRadix(context, "remainder");
  multiplyByRadix(context, "above");
  multiplyByRadix(context, "below");
  builder.emit("decq", w(DECIMAL, 8)).to("jmp", "down");
}

function emitGenerate(context: DriverContext): void {
  const { builder, r, w } = context;
  builder.at("generate").emit("xorl", w(COUNT), r(COUNT, 4)).at("digit");
  builder.emit("cmpq", r(COUNT), imm(FLOAT64_SIGNIFICANT_DIGITS)).to("jae", "format");
  multiplyByRadix(context, "remainder");
  multiplyByRadix(context, "above");
  multiplyByRadix(context, "below");
  builder.emit("xorl", w(DIGIT), r(DIGIT, 4)).at("subtract");
  compare(context, "remainder", "divisor");
  builder.emit("testl", r("rax", 4), r("rax", 4)).to("js", "subtracted");
  context.call(X64_RUNTIME_SYMBOLS.bignumSubtract, [
    bignumArgument(context, "remainder"),
    bignumArgument(context, "divisor"),
  ]);
  builder.emit("incq", w(DIGIT, 8)).to("jmp", "subtract").at("subtracted");
  compare(context, "remainder", "below");
  builder
    .emit("andl", w(FLAGS), imm((ALL_FLAGS ^ LOW_FLAG) | 0))
    .emit("testl", r("rax", 4), r("rax", 4))
    .to("js", "low")
    .to("jne", "low.done")
    .emit("testl", r(FLAGS, 4), imm(INCLUSIVE_FLAG))
    .to("je", "low.done")
    .at("low")
    .emit("orl", w(FLAGS), imm(LOW_FLAG))
    .at("low.done");
  context.call(X64_RUNTIME_SYMBOLS.bignumAdd, [
    bignumArgument(context, "scratch"),
    bignumArgument(context, "remainder"),
    bignumArgument(context, "above"),
  ]);
  compare(context, "scratch", "divisor");
  builder.emit("andl", w(FLAGS), imm((ALL_FLAGS ^ HIGH_FLAG) | 0));
  branchWhenAbove(context, "high");
  builder
    .to("jmp", "high.done")
    .at("high")
    .emit("orl", w(FLAGS), imm(HIGH_FLAG))
    .at("high.done")
    .emit("testl", r(FLAGS, 4), imm(LOW_FLAG | HIGH_FLAG))
    .to("jne", "decide");
  emitDigit(context);
  builder.emit("incq", w(COUNT, 8)).to("jmp", "digit").at("decide");
  builder
    .emit("movl", w("rax"), r(FLAGS, 4))
    .emit("andl", w("rax"), imm(LOW_FLAG | HIGH_FLAG))
    .emit("cmpl", r("rax", 4), imm(LOW_FLAG | HIGH_FLAG))
    .to("jne", "settle");
  context.call(X64_RUNTIME_SYMBOLS.bignumCopy, [
    bignumArgument(context, "scratch"),
    bignumArgument(context, "remainder"),
  ]);
  context.call(X64_RUNTIME_SYMBOLS.bignumMultiply, [
    bignumArgument(context, "scratch"),
    immediateArgument(context, 2),
  ]);
  compare(context, "scratch", "divisor");
  builder
    .emit("andl", w(FLAGS), imm((ALL_FLAGS ^ HIGH_FLAG) | 0))
    .emit("testl", r("rax", 4), r("rax", 4))
    .to("jg", "tie")
    .to("jne", "settle")
    .emit("movl", w("rdx"), r(DIGIT, 4))
    .emit("andl", w("rdx"), imm(1))
    .to("je", "settle")
    .at("tie")
    .emit("orl", w(FLAGS), imm(HIGH_FLAG))
    .at("settle")
    .emit("testl", r(FLAGS, 4), imm(HIGH_FLAG))
    .to("je", "settled")
    .emit("incq", w(DIGIT, 8))
    .at("settled");
  emitDigit(context);
  builder.emit("incq", w(COUNT, 8));
}

function emitDigit(context: DriverContext): void {
  const { builder, r, w } = context;
  digitsAddress(context, "r8");
  builder
    .emit("movl", w("rax"), r(DIGIT, 4))
    .emit("addl", w("rax"), imm(DIGIT_ZERO))
    .emit("movb", mem(1, { base: r("r8"), index: r(COUNT), scale: 1 }), r("rax", 1));
}

function emitFormat(context: DriverContext): void {
  const { builder, r, w } = context;
  builder
    .at("format")
    .emit("testl", r(FLAGS, 4), imm(NEGATIVE_FLAG))
    .to("je", "unsigned");
  writeByte(context, MINUS_SIGN);
  builder
    .at("unsigned")
    .emit("cmpq", r(DECIMAL), imm(FLOAT64_FIXED_EXPONENT_LIMIT))
    .to("jg", "exponential")
    .emit("cmpq", r(DECIMAL), imm(FLOAT64_FRACTION_EXPONENT_LIMIT))
    .to("jle", "exponential")
    .emit("testq", r(DECIMAL), r(DECIMAL))
    .to("jg", "integral");
  writeByte(context, DIGIT_ZERO);
  writeByte(context, DECIMAL_POINT);
  builder.emit("movq", w("rcx", 8), r(DECIMAL)).emit("negq", w("rcx", 8));
  padWith(context, DIGIT_ZERO, "rcx", "lead");
  builder.emit("xorl", w("r10"), r("r10", 4));
  copyDigits(context, r("r10"), COUNT, "fraction.digits");
  builder.to("jmp", "terminate").at("integral");
  builder.emit("cmpq", r(DECIMAL), r(COUNT)).to("jl", "pointed");
  builder.emit("xorl", w("r10"), r("r10", 4));
  copyDigits(context, r("r10"), COUNT, "integral.digits");
  builder
    .emit("movq", w("rcx", 8), r(DECIMAL))
    .emit("subq", w("rcx", 8), r(COUNT));
  padWith(context, DIGIT_ZERO, "rcx", "trail");
  builder.to("jmp", "terminate").at("pointed");
  builder.emit("xorl", w("r10"), r("r10", 4));
  copyDigits(context, r("r10"), DECIMAL, "pointed.head");
  writeByte(context, DECIMAL_POINT);
  copyDigits(context, r(DECIMAL), COUNT, "pointed.tail");
  builder.to("jmp", "terminate").at("exponential");
  digitsAddress(context, "r8");
  builder
    .emit("movzbl", w("rax"), mem(1, { base: r("r8") }))
    .emit("movb", mem(1, { base: r(CURSOR) }), r("rax", 1))
    .emit("incq", w(CURSOR, 8))
    .emit("cmpq", r(COUNT), imm(1))
    .to("jle", "mark");
  writeByte(context, DECIMAL_POINT);
  builder.emit("movl", w("r10"), imm(1));
  copyDigits(context, r("r10"), COUNT, "exponential.tail");
  builder.at("mark");
  writeByte(context, EXPONENT_MARK);
  builder.emit("decq", w(DECIMAL, 8)).emit("testq", r(DECIMAL), r(DECIMAL)).to("jns", "plus");
  writeByte(context, MINUS_SIGN);
  builder.emit("negq", w(DECIMAL, 8)).to("jmp", "magnitude").at("plus");
  writeByte(context, PLUS_SIGN);
  builder.at("magnitude");
  emitExponentDigits(context);
  builder.at("terminate");
  builder
    .emit("movb", mem(1, { base: r(CURSOR) }), imm(TERMINATOR))
    .at("return")
    .emit("movq", w("rax", 8), context.state(STATE_DESTINATION, 8));
  const frame = shadowBytes(context.abi);
  if (frame !== 0) {
    builder.emit("addq", w(context.abi.stackPointer.name, 8), imm(frame));
  }
  for (const name of [...SAVED].reverse()) builder.emit("popq", w(name, 8));
  builder.ret();
}

function emitExponentDigits(context: DriverContext): void {
  const { builder, r, w } = context;
  const scratch = builder.data(
    EXPONENT_KEY,
    1,
    zeroFilledBuffer(INT32_DECIMAL_BYTES),
    true,
  );
  const names = x64IntegerArgumentNames(context.abi);
  builder
    .emit("leaq", w(names[0]!, 8), mem(1, { symbol: scratch.label }))
    .emit("movl", w(names[1]!), imm(INT32_DECIMAL_BYTES))
    .emit("movl", w(names[2]!), r(DECIMAL, 4))
    .callSymbol(X64_RUNTIME_SYMBOLS.int32ToString)
    .emit("movq", w("r8", 8), r("rax"))
    .at("magnitude.copy")
    .emit("movzbl", w("rax"), mem(1, { base: r("r8") }))
    .emit("testl", r("rax", 4), r("rax", 4))
    .to("je", "terminate")
    .emit("movb", mem(1, { base: r(CURSOR) }), r("rax", 1))
    .emit("incq", w(CURSOR, 8))
    .emit("incq", w("r8", 8))
    .to("jmp", "magnitude.copy");
}

function floatToString(abi: RuntimeAbi) {
  return (builder: MachineRoutineBuilder): void => {
    const context = driverContext(builder, abi);
    emitDecode(context, abi);
    emitSetup(context);
    emitScale(context);
    emitGenerate(context);
    emitFormat(context);
  };
}

export function x64FloatTextRoutines(
  abi: RuntimeAbi,
): ReadonlyMap<string, (builder: MachineRoutineBuilder) => void> {
  return new Map([
    [X64_RUNTIME_SYMBOLS.bignumSet, bignumSet(abi)],
    [X64_RUNTIME_SYMBOLS.bignumCopy, bignumCopy(abi)],
    [X64_RUNTIME_SYMBOLS.bignumMultiply, bignumMultiply(abi)],
    [X64_RUNTIME_SYMBOLS.bignumShift, bignumShift(abi)],
    [X64_RUNTIME_SYMBOLS.bignumCompare, bignumCompare(abi)],
    [X64_RUNTIME_SYMBOLS.bignumSubtract, bignumSubtract(abi)],
    [X64_RUNTIME_SYMBOLS.bignumAdd, bignumAdd(abi)],
    [X64_RUNTIME_SYMBOLS.floatToString, floatToString(abi)],
  ]);
}
