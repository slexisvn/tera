import { asciiData, INT32_DECIMAL_BYTES, zeroFilledBuffer } from "../../machine/data.js";
import { imm, mem, sym, type RegisterOperand } from "../../machine/ir.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
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
import { TERA_POINTER_BYTES } from "../../target/runtime-layout.js";
import {
  BIGNUM_NAMES,
  DECIMAL_POINT,
  ABSENCE_VALUES,
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
  type BignumName,
} from "../../target/float-text-spec.js";
import { RISCV_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const WORD = TERA_POINTER_BYTES;
const STACK_ALIGNMENT_BYTES = 16;

const CURSOR = "s1";
const DECIMAL = "s2";
const COUNT = "s3";
const FLAGS = "s4";
const DIGIT = "s5";
const SAVED: readonly string[] = ["ra", CURSOR, DECIMAL, COUNT, FLAGS, DIGIT];
const FRAME_BYTES =
  Math.ceil((SAVED.length * WORD) / STACK_ALIGNMENT_BYTES) * STACK_ALIGNMENT_BYTES;

const KEYS = floatTextKeys("rv64");
const STATE_KEY = KEYS.state;
const DIGITS_KEY = KEYS.digits;
const EXPONENT_KEY = KEYS.exponent;

const bignumKey = KEYS.bignum;

function reader(builder: MachineRoutineBuilder) {
  return (name: string, width = WORD): RegisterOperand => builder.read(name, width);
}

function writer(builder: MachineRoutineBuilder) {
  return (name: string, width = WORD): RegisterOperand => builder.write(name, width);
}

function limbAddress(
  builder: MachineRoutineBuilder,
  destination: string,
  base: string,
  index: string,
): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("slli", w(destination), r(index), imm(Math.log2(FLOAT64_LIMB_BYTES)))
    .emit("add", w(destination), r(base), r(destination));
}

function loadLimb(
  builder: MachineRoutineBuilder,
  destination: string,
  address: string,
): void {
  builder.emit(
    "lwu",
    writer(builder)(destination),
    mem(FLOAT64_LIMB_BYTES, {
      base: reader(builder)(address),
      displacement: FLOAT64_BIGNUM_LENGTH_BYTES,
    }),
  );
}

function storeLimb(builder: MachineRoutineBuilder, value: string, address: string): void {
  builder.emit(
    "sw",
    reader(builder)(value),
    mem(FLOAT64_LIMB_BYTES, {
      base: reader(builder)(address),
      displacement: FLOAT64_BIGNUM_LENGTH_BYTES,
    }),
  );
}

function bignumSet(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("li", w("t0"), imm(0))
    .emit("mv", w("t1"), r("a1"))
    .at("scan")
    .to("beqz", "done", r("t1"));
  limbAddress(builder, "t2", "a0", "t0");
  storeLimb(builder, "t1", "t2");
  builder
    .emit("addi", w("t0"), r("t0"), imm(1))
    .emit("srli", w("t1"), r("t1"), imm(FLOAT64_LIMB_BITS))
    .to("j", "scan")
    .at("done")
    .emit("sd", r("t0"), mem(WORD, { base: r("a0") }))
    .ret();
}

function bignumCopy(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("ld", w("t0"), mem(WORD, { base: r("a1") }))
    .emit("sd", r("t0"), mem(WORD, { base: r("a0") }))
    .emit("li", w("t1"), imm(0))
    .at("scan")
    .to("bgeu", "done", r("t1"), r("t0"));
  limbAddress(builder, "t2", "a1", "t1");
  loadLimb(builder, "t3", "t2");
  limbAddress(builder, "t2", "a0", "t1");
  storeLimb(builder, "t3", "t2");
  builder
    .emit("addi", w("t1"), r("t1"), imm(1))
    .to("j", "scan")
    .at("done")
    .ret();
}

function bignumMultiply(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("ld", w("t0"), mem(WORD, { base: r("a0") }))
    .emit("li", w("t1"), imm(0))
    .emit("li", w("t2"), imm(0))
    .at("scan")
    .to("bgeu", "carry", r("t1"), r("t0"));
  limbAddress(builder, "t3", "a0", "t1");
  loadLimb(builder, "t4", "t3");
  builder
    .emit("mul", w("t4"), r("t4"), r("a1"))
    .emit("add", w("t4"), r("t4"), r("t2"));
  storeLimb(builder, "t4", "t3");
  builder
    .emit("srli", w("t2"), r("t4"), imm(FLOAT64_LIMB_BITS))
    .emit("addi", w("t1"), r("t1"), imm(1))
    .to("j", "scan")
    .at("carry")
    .to("beqz", "done", r("t2"));
  limbAddress(builder, "t3", "a0", "t0");
  storeLimb(builder, "t2", "t3");
  builder
    .emit("addi", w("t0"), r("t0"), imm(1))
    .emit("srli", w("t2"), r("t2"), imm(FLOAT64_LIMB_BITS))
    .to("j", "carry")
    .at("done")
    .emit("sd", r("t0"), mem(WORD, { base: r("a0") }))
    .ret();
}

function bignumShift(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("ld", w("t0"), mem(WORD, { base: r("a0") }))
    .to("beqz", "done", r("t0"))
    .emit("srliw", w("t1"), r("a1"), imm(Math.log2(FLOAT64_LIMB_BITS)))
    .emit("andi", w("t2"), r("a1"), imm(FLOAT64_LIMB_BITS - 1))
    .emit("li", w("t3"), imm(0))
    .emit("li", w("t4"), imm(0))
    .to("beqz", "words", r("t2"))
    .at("bits")
    .to("bgeu", "spill", r("t4"), r("t0"));
  limbAddress(builder, "t5", "a0", "t4");
  loadLimb(builder, "t6", "t5");
  builder
    .emit("sll", w("t6"), r("t6"), r("t2"))
    .emit("or", w("t6"), r("t6"), r("t3"));
  storeLimb(builder, "t6", "t5");
  builder
    .emit("srli", w("t3"), r("t6"), imm(FLOAT64_LIMB_BITS))
    .emit("addi", w("t4"), r("t4"), imm(1))
    .to("j", "bits")
    .at("spill")
    .to("beqz", "words", r("t3"));
  limbAddress(builder, "t5", "a0", "t0");
  storeLimb(builder, "t3", "t5");
  builder
    .emit("addi", w("t0"), r("t0"), imm(1))
    .at("words")
    .to("beqz", "store", r("t1"))
    .emit("addi", w("t4"), r("t0"), imm(-1))
    .at("move")
    .to("bltz", "clear", r("t4"));
  limbAddress(builder, "t5", "a0", "t4");
  loadLimb(builder, "t6", "t5");
  builder.emit("add", w("t3"), r("t4"), r("t1"));
  limbAddress(builder, "t5", "a0", "t3");
  storeLimb(builder, "t6", "t5");
  builder
    .emit("addi", w("t4"), r("t4"), imm(-1))
    .to("j", "move")
    .at("clear")
    .emit("li", w("t4"), imm(0))
    .at("zero")
    .to("bgeu", "grow", r("t4"), r("t1"));
  limbAddress(builder, "t5", "a0", "t4");
  storeLimb(builder, "zero", "t5");
  builder
    .emit("addi", w("t4"), r("t4"), imm(1))
    .to("j", "zero")
    .at("grow")
    .emit("add", w("t0"), r("t0"), r("t1"))
    .at("store")
    .emit("sd", r("t0"), mem(WORD, { base: r("a0") }))
    .at("done")
    .ret();
}

function bignumCompare(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("ld", w("t0"), mem(WORD, { base: r("a0") }))
    .emit("ld", w("t1"), mem(WORD, { base: r("a1") }))
    .to("bltu", "below", r("t0"), r("t1"))
    .to("bltu", "above", r("t1"), r("t0"))
    .emit("mv", w("t2"), r("t0"))
    .at("scan")
    .to("beqz", "equal", r("t2"))
    .emit("addi", w("t2"), r("t2"), imm(-1));
  limbAddress(builder, "t3", "a0", "t2");
  loadLimb(builder, "t4", "t3");
  limbAddress(builder, "t3", "a1", "t2");
  loadLimb(builder, "t5", "t3");
  builder
    .to("bltu", "below", r("t4"), r("t5"))
    .to("bltu", "above", r("t5"), r("t4"))
    .to("j", "scan")
    .at("equal")
    .emit("li", w("a0"), imm(0))
    .ret()
    .at("below")
    .emit("li", w("a0"), imm(-1))
    .ret()
    .at("above")
    .emit("li", w("a0"), imm(1))
    .ret();
}

function bignumSubtract(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("ld", w("t0"), mem(WORD, { base: r("a0") }))
    .emit("ld", w("t1"), mem(WORD, { base: r("a1") }))
    .emit("li", w("t2"), imm(0))
    .emit("li", w("t3"), imm(0))
    .at("scan")
    .to("bgeu", "trim", r("t2"), r("t0"))
    .emit("li", w("t4"), imm(0))
    .to("bgeu", "taken", r("t2"), r("t1"));
  limbAddress(builder, "t5", "a1", "t2");
  loadLimb(builder, "t4", "t5");
  builder.at("taken").emit("add", w("t4"), r("t4"), r("t3"));
  limbAddress(builder, "t5", "a0", "t2");
  loadLimb(builder, "t6", "t5");
  builder
    .emit("sltu", w("t3"), r("t6"), r("t4"))
    .emit("sub", w("t6"), r("t6"), r("t4"));
  storeLimb(builder, "t6", "t5");
  builder
    .emit("addi", w("t2"), r("t2"), imm(1))
    .to("j", "scan")
    .at("trim")
    .to("beqz", "store", r("t0"))
    .emit("addi", w("t2"), r("t0"), imm(-1));
  limbAddress(builder, "t5", "a0", "t2");
  loadLimb(builder, "t6", "t5");
  builder
    .to("bnez", "store", r("t6"))
    .emit("mv", w("t0"), r("t2"))
    .to("j", "trim")
    .at("store")
    .emit("sd", r("t0"), mem(WORD, { base: r("a0") }))
    .ret();
}

function bignumAdd(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("ld", w("t0"), mem(WORD, { base: r("a1") }))
    .emit("ld", w("t1"), mem(WORD, { base: r("a2") }))
    .emit("mv", w("t2"), r("t0"))
    .to("bgeu", "widest", r("t0"), r("t1"))
    .emit("mv", w("t2"), r("t1"))
    .at("widest")
    .emit("li", w("t3"), imm(0))
    .emit("li", w("t4"), imm(0))
    .at("scan")
    .to("bgeu", "carry", r("t3"), r("t2"))
    .emit("li", w("t5"), imm(0))
    .to("bgeu", "right", r("t3"), r("t0"));
  limbAddress(builder, "t6", "a1", "t3");
  loadLimb(builder, "t5", "t6");
  builder.at("right").emit("mv", w("a3"), r("zero")).to("bgeu", "sum", r("t3"), r("t1"));
  limbAddress(builder, "t6", "a2", "t3");
  loadLimb(builder, "a3", "t6");
  builder
    .at("sum")
    .emit("add", w("t5"), r("t5"), r("a3"))
    .emit("add", w("t5"), r("t5"), r("t4"));
  limbAddress(builder, "t6", "a0", "t3");
  storeLimb(builder, "t5", "t6");
  builder
    .emit("srli", w("t4"), r("t5"), imm(FLOAT64_LIMB_BITS))
    .emit("addi", w("t3"), r("t3"), imm(1))
    .to("j", "scan")
    .at("carry")
    .to("beqz", "store", r("t4"));
  limbAddress(builder, "t6", "a0", "t2");
  storeLimb(builder, "t4", "t6");
  builder
    .emit("addi", w("t2"), r("t2"), imm(1))
    .at("store")
    .emit("sd", r("t2"), mem(WORD, { base: r("a0") }))
    .ret();
}

interface DriverContext {
  readonly builder: MachineRoutineBuilder;
  readonly r: (name: string, width?: number) => RegisterOperand;
  readonly w: (name: string, width?: number) => RegisterOperand;
  address(name: BignumName, register: string): void;
  call(symbol: string, load: readonly ((destination: string) => void)[]): void;
  state(offset: number, register: string): void;
}

const ARGUMENTS: readonly string[] = ["a0", "a1", "a2"];

function driverContext(builder: MachineRoutineBuilder): DriverContext {
  const r = reader(builder);
  const w = writer(builder);
  const stateDatum = () =>
    builder.data(STATE_KEY, WORD, zeroFilledBuffer(STATE_BYTES), true);
  return {
    builder,
    r,
    w,
    address: (name, register) => {
      const datum = builder.data(
        bignumKey(name),
        WORD,
        zeroFilledBuffer(FLOAT64_BIGNUM_BYTES),
        true,
      );
      builder.emit("lla", w(register), sym(datum.label));
    },
    call: (symbol, load) => {
      load.forEach((set, index) => set(ARGUMENTS[index]!));
      builder.callSymbol(symbol);
    },
    state: (offset, register) => {
      builder
        .emit("lla", w("t0"), sym(stateDatum().label))
        .emit("lw", w(register), mem(4, { base: r("t0"), displacement: offset }));
    },
  };
}

function storeState(context: DriverContext, offset: number, source: string): void {
  const { builder, r, w } = context;
  const datum = builder.data(STATE_KEY, WORD, zeroFilledBuffer(STATE_BYTES), true);
  builder
    .emit("lla", w("t0"), sym(datum.label))
    .emit("sw", r(source), mem(4, { base: r("t0"), displacement: offset }));
}

function bignumArgument(context: DriverContext, name: BignumName) {
  return (destination: string): void => context.address(name, destination);
}

function immediateArgument(context: DriverContext, value: number) {
  return (destination: string): void => {
    context.builder.emit("li", context.w(destination), imm(value));
  };
}

function registerArgument(context: DriverContext, source: string) {
  return (destination: string): void => {
    context.builder.emit("mv", context.w(destination), context.r(source));
  };
}

function stateArgument(context: DriverContext, offset: number) {
  return (destination: string): void => context.state(offset, destination);
}

function multiplyByRadix(context: DriverContext, name: BignumName): void {
  context.call(RISCV_RUNTIME_SYMBOLS.bignumMultiply, [
    bignumArgument(context, name),
    immediateArgument(context, RADIX),
  ]);
}

function compare(context: DriverContext, left: BignumName, right: BignumName): void {
  context.call(RISCV_RUNTIME_SYMBOLS.bignumCompare, [
    bignumArgument(context, left),
    bignumArgument(context, right),
  ]);
}

function branchWhenAbove(context: DriverContext, target: string): void {
  const { builder, r, w } = context;
  builder
    .to("bgtz", target, r("a0"))
    .to("bltz", `${target}.below`, r("a0"))
    .emit("andi", w("t0"), r(FLAGS), imm(INCLUSIVE_FLAG))
    .to("bnez", target, r("t0"))
    .at(`${target}.below`);
}

function copyUntilTerminator(context: DriverContext, address: string, block: string): void {
  const { builder, r, w } = context;
  builder
    .at(block)
    .emit("lbu", w("t1"), mem(1, { base: r(address) }))
    .to("beqz", `${block}.done`, r("t1"))
    .emit("sb", r("t1"), mem(1, { base: r(CURSOR) }))
    .emit("addi", w(CURSOR), r(CURSOR), imm(1))
    .emit("addi", w(address), r(address), imm(1))
    .to("j", block)
    .at(`${block}.done`);
}

function copyText(context: DriverContext, text: string, block: string): void {
  const { builder, w } = context;
  const datum = builder.data(KEYS.ofText(text), 1, [asciiData(text)]);
  builder.emit("lla", w("t0"), sym(datum.label));
  copyUntilTerminator(context, "t0", block);
}

function digitsAddress(context: DriverContext, register: string): void {
  const datum = context.builder.data(
    DIGITS_KEY,
    1,
    zeroFilledBuffer(FLOAT64_SIGNIFICANT_DIGITS),
    true,
  );
  context.builder.emit("lla", context.w(register), sym(datum.label));
}

function writeByte(context: DriverContext, value: number): void {
  const { builder, r, w } = context;
  builder
    .emit("li", w("t1"), imm(value))
    .emit("sb", r("t1"), mem(1, { base: r(CURSOR) }))
    .emit("addi", w(CURSOR), r(CURSOR), imm(1));
}

function copyDigits(
  context: DriverContext,
  from: string,
  to: string,
  block: string,
): void {
  const { builder, r, w } = context;
  digitsAddress(context, "t2");
  builder
    .emit("mv", w("t3"), r(from))
    .at(block)
    .to("bge", `${block}.done`, r("t3"), r(to))
    .emit("add", w("t4"), r("t2"), r("t3"))
    .emit("lbu", w("t1"), mem(1, { base: r("t4") }))
    .emit("sb", r("t1"), mem(1, { base: r(CURSOR) }))
    .emit("addi", w(CURSOR), r(CURSOR), imm(1))
    .emit("addi", w("t3"), r("t3"), imm(1))
    .to("j", block)
    .at(`${block}.done`);
}

function padWith(context: DriverContext, value: number, count: string, block: string): void {
  const { builder, r, w } = context;
  builder.at(block).to("blez", `${block}.done`, r(count));
  writeByte(context, value);
  builder
    .emit("addi", w(count), r(count), imm(-1))
    .to("j", block)
    .at(`${block}.done`);
}

function emitDecode(context: DriverContext): void {
  const { builder, r, w } = context;
  builder.emit("addi", w("sp"), r("sp"), imm(-FRAME_BYTES));
  SAVED.forEach((name, index) => {
    builder.emit("sd", r(name), mem(WORD, { base: r("sp"), displacement: index * WORD }));
  });
  builder.emit("mv", w(CURSOR), r("a0"));
  const datum = builder.data(STATE_KEY, WORD, zeroFilledBuffer(STATE_BYTES), true);
  builder
    .emit("lla", w("t0"), sym(datum.label))
    .emit("sd", r(CURSOR), mem(WORD, { base: r("t0"), displacement: STATE_DESTINATION }))
    .emit("li", w("t1"), imm(FLOAT64_DECIMAL_BYTES))
    .to("bge", "decode", r("a1"), r("t1"))
    .to("blez", "return", r("a1"))
    .emit("sb", r("zero"), mem(1, { base: r(CURSOR) }))
    .to("j", "return")
    .at("decode")
    .emit("fmv.x.d", w(DIGIT), r("fa0"));
  ABSENCE_VALUES.forEach((absence, index) => {
    const present = `absent.${index}.present`;
    builder
      .emit("li", w("t3"), imm(absence.bits))
      .to("bne", present, r(DIGIT), r("t3"));
    copyText(context, absence.text, `absent.${index}.text`);
    builder.to("j", "terminate").at(present);
  });
  builder
    .emit("srli", w(FLAGS), r(DIGIT), imm(FLOAT64_SIGN_SHIFT))
    .emit("srli", w("t2"), r(DIGIT), imm(FLOAT64_MANTISSA_BITS))
    .emit("andi", w("t2"), r("t2"), imm(FLOAT64_EXPONENT_MASK))
    .emit("li", w("t3"), imm(FLOAT64_MANTISSA_MASK))
    .emit("and", w(DIGIT), r(DIGIT), r("t3"))
    .emit("li", w("t3"), imm(FLOAT64_EXPONENT_MASK))
    .to("bne", "finite", r("t2"), r("t3"))
    .to("bnez", "notANumber", r(DIGIT))
    .emit("andi", w("t3"), r(FLAGS), imm(NEGATIVE_FLAG))
    .to("bnez", "negativeInfinity", r("t3"));
  copyText(context, INFINITY_TEXT, "infinity");
  builder.to("j", "terminate").at("notANumber");
  copyText(context, NOT_A_NUMBER_TEXT, "notANumber.text");
  builder.to("j", "terminate").at("negativeInfinity");
  copyText(context, NEGATIVE_INFINITY_TEXT, "negativeInfinity.text");
  builder.to("j", "terminate").at("finite").to("bnez", "normal", r("t2"));
  builder.to("bnez", "subnormal", r(DIGIT));
  writeByte(context, DIGIT_ZERO);
  builder
    .to("j", "terminate")
    .at("subnormal")
    .emit("li", w("t4"), imm(FLOAT64_MIN_EXPONENT))
    .to("j", "decoded")
    .at("normal")
    .emit("li", w("t3"), imm(1))
    .emit("slli", w("t3"), r("t3"), imm(FLOAT64_MANTISSA_BITS))
    .emit("or", w(DIGIT), r(DIGIT), r("t3"))
    .emit("addi", w("t4"), r("t2"), imm(-FLOAT64_EXPONENT_BIAS))
    .at("decoded")
    .emit("andi", w("t5"), r(DIGIT), imm(1))
    .emit("xori", w("t5"), r("t5"), imm(1))
    .emit("slli", w("t5"), r("t5"), imm(1))
    .emit("or", w(FLAGS), r(FLAGS), r("t5"))
    .emit("li", w("t6"), imm(1))
    .emit("li", w("t3"), imm(1))
    .emit("slli", w("t3"), r("t3"), imm(FLOAT64_MANTISSA_BITS))
    .to("bne", "step", r(DIGIT), r("t3"))
    .emit("li", w("t3"), imm(1))
    .to("bge", "step", r("t3"), r("t2"))
    .emit("li", w("t6"), imm(2))
    .at("step")
    .emit("li", w("t0"), imm(0))
    .emit("li", w("t1"), imm(0))
    .to("blez", "negativeExponent", r("t4"))
    .emit("mv", w("t0"), r("t4"))
    .to("j", "shifts")
    .at("negativeExponent")
    .emit("sub", w("t1"), r("zero"), r("t4"))
    .at("shifts")
    .emit("add", w("t2"), r("t0"), r("t6"));
  storeState(context, STATE_REMAINDER_SHIFT, "t2");
  builder.emit("add", w("t2"), r("t1"), r("t6"));
  storeState(context, STATE_DIVISOR_SHIFT, "t2");
  storeState(context, STATE_POSITIVE_EXPONENT, "t0");
  storeState(context, STATE_STEP, "t6");
}

function emitSetup(context: DriverContext): void {
  context.call(RISCV_RUNTIME_SYMBOLS.bignumSet, [
    bignumArgument(context, "remainder"),
    registerArgument(context, DIGIT),
  ]);
  context.call(RISCV_RUNTIME_SYMBOLS.bignumShift, [
    bignumArgument(context, "remainder"),
    stateArgument(context, STATE_REMAINDER_SHIFT),
  ]);
  context.call(RISCV_RUNTIME_SYMBOLS.bignumSet, [
    bignumArgument(context, "divisor"),
    immediateArgument(context, 1),
  ]);
  context.call(RISCV_RUNTIME_SYMBOLS.bignumShift, [
    bignumArgument(context, "divisor"),
    stateArgument(context, STATE_DIVISOR_SHIFT),
  ]);
  context.call(RISCV_RUNTIME_SYMBOLS.bignumSet, [
    bignumArgument(context, "below"),
    immediateArgument(context, 1),
  ]);
  context.call(RISCV_RUNTIME_SYMBOLS.bignumShift, [
    bignumArgument(context, "below"),
    stateArgument(context, STATE_POSITIVE_EXPONENT),
  ]);
  context.call(RISCV_RUNTIME_SYMBOLS.bignumSet, [
    bignumArgument(context, "above"),
    stateArgument(context, STATE_STEP),
  ]);
  context.call(RISCV_RUNTIME_SYMBOLS.bignumShift, [
    bignumArgument(context, "above"),
    stateArgument(context, STATE_POSITIVE_EXPONENT),
  ]);
}

function emitScale(context: DriverContext): void {
  const { builder, r, w } = context;
  builder.emit("li", w(DECIMAL), imm(0));
  context.call(RISCV_RUNTIME_SYMBOLS.bignumAdd, [
    bignumArgument(context, "scratch"),
    bignumArgument(context, "remainder"),
    bignumArgument(context, "above"),
  ]);
  builder.at("up");
  compare(context, "scratch", "divisor");
  branchWhenAbove(context, "up.more");
  builder.to("j", "down").at("up.more");
  multiplyByRadix(context, "divisor");
  builder.emit("addi", w(DECIMAL), r(DECIMAL), imm(1)).to("j", "up").at("down");
  multiplyByRadix(context, "scratch");
  compare(context, "scratch", "divisor");
  branchWhenAbove(context, "generate");
  multiplyByRadix(context, "remainder");
  multiplyByRadix(context, "above");
  multiplyByRadix(context, "below");
  builder.emit("addi", w(DECIMAL), r(DECIMAL), imm(-1)).to("j", "down");
}

function emitDigit(context: DriverContext): void {
  const { builder, r, w } = context;
  digitsAddress(context, "t2");
  builder
    .emit("add", w("t2"), r("t2"), r(COUNT))
    .emit("addi", w("t1"), r(DIGIT), imm(DIGIT_ZERO))
    .emit("sb", r("t1"), mem(1, { base: r("t2") }));
}

function emitGenerate(context: DriverContext): void {
  const { builder, r, w } = context;
  builder.at("generate").emit("li", w(COUNT), imm(0)).at("digit");
  builder
    .emit("li", w("t0"), imm(FLOAT64_SIGNIFICANT_DIGITS))
    .to("bgeu", "format", r(COUNT), r("t0"));
  multiplyByRadix(context, "remainder");
  multiplyByRadix(context, "above");
  multiplyByRadix(context, "below");
  builder.emit("li", w(DIGIT), imm(0)).at("subtract");
  compare(context, "remainder", "divisor");
  builder.to("bltz", "subtracted", r("a0"));
  context.call(RISCV_RUNTIME_SYMBOLS.bignumSubtract, [
    bignumArgument(context, "remainder"),
    bignumArgument(context, "divisor"),
  ]);
  builder.emit("addi", w(DIGIT), r(DIGIT), imm(1)).to("j", "subtract").at("subtracted");
  compare(context, "remainder", "below");
  builder
    .emit("andi", w(FLAGS), r(FLAGS), imm(~LOW_FLAG))
    .to("bltz", "low", r("a0"))
    .to("bnez", "low.done", r("a0"))
    .emit("andi", w("t0"), r(FLAGS), imm(INCLUSIVE_FLAG))
    .to("beqz", "low.done", r("t0"))
    .at("low")
    .emit("ori", w(FLAGS), r(FLAGS), imm(LOW_FLAG))
    .at("low.done");
  context.call(RISCV_RUNTIME_SYMBOLS.bignumAdd, [
    bignumArgument(context, "scratch"),
    bignumArgument(context, "remainder"),
    bignumArgument(context, "above"),
  ]);
  compare(context, "scratch", "divisor");
  builder.emit("andi", w(FLAGS), r(FLAGS), imm(~HIGH_FLAG));
  branchWhenAbove(context, "high");
  builder
    .to("j", "high.done")
    .at("high")
    .emit("ori", w(FLAGS), r(FLAGS), imm(HIGH_FLAG))
    .at("high.done")
    .emit("andi", w("t0"), r(FLAGS), imm(LOW_FLAG | HIGH_FLAG))
    .to("bnez", "decide", r("t0"));
  emitDigit(context);
  builder.emit("addi", w(COUNT), r(COUNT), imm(1)).to("j", "digit").at("decide");
  builder
    .emit("andi", w("t0"), r(FLAGS), imm(LOW_FLAG | HIGH_FLAG))
    .emit("li", w("t1"), imm(LOW_FLAG | HIGH_FLAG))
    .to("bne", "settle", r("t0"), r("t1"));
  context.call(RISCV_RUNTIME_SYMBOLS.bignumCopy, [
    bignumArgument(context, "scratch"),
    bignumArgument(context, "remainder"),
  ]);
  context.call(RISCV_RUNTIME_SYMBOLS.bignumMultiply, [
    bignumArgument(context, "scratch"),
    immediateArgument(context, 2),
  ]);
  compare(context, "scratch", "divisor");
  builder
    .emit("andi", w(FLAGS), r(FLAGS), imm(~HIGH_FLAG))
    .to("bgtz", "tie", r("a0"))
    .to("bnez", "settle", r("a0"))
    .emit("andi", w("t0"), r(DIGIT), imm(1))
    .to("beqz", "settle", r("t0"))
    .at("tie")
    .emit("ori", w(FLAGS), r(FLAGS), imm(HIGH_FLAG))
    .at("settle")
    .emit("andi", w("t0"), r(FLAGS), imm(HIGH_FLAG))
    .to("beqz", "settled", r("t0"))
    .emit("addi", w(DIGIT), r(DIGIT), imm(1))
    .at("settled");
  emitDigit(context);
  builder.emit("addi", w(COUNT), r(COUNT), imm(1));
}

function emitFormat(context: DriverContext): void {
  const { builder, r, w } = context;
  builder
    .at("format")
    .emit("andi", w("t0"), r(FLAGS), imm(NEGATIVE_FLAG))
    .to("beqz", "unsigned", r("t0"));
  writeByte(context, MINUS_SIGN);
  builder
    .at("unsigned")
    .emit("li", w("t0"), imm(FLOAT64_FIXED_EXPONENT_LIMIT))
    .to("blt", "exponential", r("t0"), r(DECIMAL))
    .emit("li", w("t0"), imm(FLOAT64_FRACTION_EXPONENT_LIMIT))
    .to("bge", "exponential", r("t0"), r(DECIMAL))
    .to("bgtz", "integral", r(DECIMAL));
  writeByte(context, DIGIT_ZERO);
  writeByte(context, DECIMAL_POINT);
  builder.emit("sub", w("t5"), r("zero"), r(DECIMAL));
  padWith(context, DIGIT_ZERO, "t5", "lead");
  builder.emit("li", w("t6"), imm(0));
  copyDigits(context, "t6", COUNT, "fraction.digits");
  builder.to("j", "terminate").at("integral");
  builder.to("blt", "pointed", r(DECIMAL), r(COUNT)).emit("li", w("t6"), imm(0));
  copyDigits(context, "t6", COUNT, "integral.digits");
  builder.emit("sub", w("t5"), r(DECIMAL), r(COUNT));
  padWith(context, DIGIT_ZERO, "t5", "trail");
  builder.to("j", "terminate").at("pointed").emit("li", w("t6"), imm(0));
  copyDigits(context, "t6", DECIMAL, "pointed.head");
  writeByte(context, DECIMAL_POINT);
  copyDigits(context, DECIMAL, COUNT, "pointed.tail");
  builder.to("j", "terminate").at("exponential");
  digitsAddress(context, "t2");
  builder
    .emit("lbu", w("t1"), mem(1, { base: r("t2") }))
    .emit("sb", r("t1"), mem(1, { base: r(CURSOR) }))
    .emit("addi", w(CURSOR), r(CURSOR), imm(1))
    .emit("li", w("t0"), imm(1))
    .to("bge", "mark", r("t0"), r(COUNT));
  writeByte(context, DECIMAL_POINT);
  builder.emit("li", w("t6"), imm(1));
  copyDigits(context, "t6", COUNT, "exponential.tail");
  builder.at("mark");
  writeByte(context, EXPONENT_MARK);
  builder.emit("addi", w(DECIMAL), r(DECIMAL), imm(-1)).to("bgez", "plus", r(DECIMAL));
  writeByte(context, MINUS_SIGN);
  builder.emit("sub", w(DECIMAL), r("zero"), r(DECIMAL)).to("j", "magnitude").at("plus");
  writeByte(context, PLUS_SIGN);
  builder.at("magnitude");
  emitExponentDigits(context);
  builder
    .at("terminate")
    .emit("sb", r("zero"), mem(1, { base: r(CURSOR) }))
    .at("return");
  const datum = builder.data(STATE_KEY, WORD, zeroFilledBuffer(STATE_BYTES), true);
  builder
    .emit("lla", w("t0"), sym(datum.label))
    .emit("ld", w("a0"), mem(WORD, { base: r("t0"), displacement: STATE_DESTINATION }));
  SAVED.forEach((name, index) => {
    builder.emit("ld", w(name), mem(WORD, { base: r("sp"), displacement: index * WORD }));
  });
  builder.emit("addi", w("sp"), r("sp"), imm(FRAME_BYTES)).ret();
}

function emitExponentDigits(context: DriverContext): void {
  const { builder, r, w } = context;
  const scratch = builder.data(
    EXPONENT_KEY,
    1,
    zeroFilledBuffer(INT32_DECIMAL_BYTES),
    true,
  );
  builder
    .emit("mv", w("a2"), r(DECIMAL))
    .emit("lla", w("a0"), sym(scratch.label))
    .emit("li", w("a1"), imm(INT32_DECIMAL_BYTES))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.int32ToString)
    .emit("mv", w("t0"), r("a0"));
  copyUntilTerminator(context, "t0", "magnitude.copy");
  builder.to("j", "terminate");
}

function floatToString(builder: MachineRoutineBuilder): void {
  const context = driverContext(builder);
  emitDecode(context);
  emitSetup(context);
  emitScale(context);
  emitGenerate(context);
  emitFormat(context);
}

export function riscvFloatTextRoutines(): ReadonlyMap<
  string,
  (builder: MachineRoutineBuilder) => void
> {
  return new Map([
    [RISCV_RUNTIME_SYMBOLS.bignumSet, bignumSet],
    [RISCV_RUNTIME_SYMBOLS.bignumCopy, bignumCopy],
    [RISCV_RUNTIME_SYMBOLS.bignumMultiply, bignumMultiply],
    [RISCV_RUNTIME_SYMBOLS.bignumShift, bignumShift],
    [RISCV_RUNTIME_SYMBOLS.bignumCompare, bignumCompare],
    [RISCV_RUNTIME_SYMBOLS.bignumSubtract, bignumSubtract],
    [RISCV_RUNTIME_SYMBOLS.bignumAdd, bignumAdd],
    [RISCV_RUNTIME_SYMBOLS.floatToString, floatToString],
  ]);
}
