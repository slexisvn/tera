import { imm, mem, sym, type RegisterOperand } from "../../machine/ir.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
import {
  ARRAY_CAPACITY_OFFSET,
  ARRAY_ELEMENTS_OFFSET,
  ARRAY_GROWTH_FACTOR,
  ARRAY_INITIAL_CAPACITY,
  ARRAY_LENGTH_OFFSET,
  BUFFER_ELEMENTS_OFFSET,
  ALIGNMENT_ROUNDING,
  CLASS_ALIGNMENT_BYTES,
  CLASS_FLAGS_OFFSET,
  CLASS_HEADER_BYTES,
  CLASS_SHAPE_ID_OFFSET,
  CLEAR_MARK,
  FREE_BLOCK_BYTES,
  GROWTH_SHIFT,
} from "../../metadata/class-table.js";
import {
  TERA_CLASS_FIELDS,
  TERA_CLASS_RECORD,
  TERA_CLASS_RECORD_SHIFT,
  TERA_COUNT_SHIFT,
  TERA_CONTEXT,
  TERA_FREE_SHAPE_ID,
  TERA_HEAP_COMMIT_BYTES,
  TERA_LINK_BYTES,
  TERA_MARK_FLAG,
  TERA_MARKS,
  TERA_ROOT_CAPACITY,
  TERA_ROOT_ENTRY_BYTES,
  TERA_ROOT_SLOT_SHIFT,
  TERA_ROOTS,
  TERA_STATIC_ROOT_COUNT,
  TERA_STATIC_ROOTS,
  TERA_STATICS,
  TERA_COUNT_BYTES,
  TERA_POINTER_BYTES,
  type TeraContextField,
} from "../../target/runtime-layout.js";
import { TERA_EXIT_HEAP_EXHAUSTED } from "../../target/faults.js";
import {
  MMAP_ERROR_LIMIT,
  MMAP_NO_FILE,
  PROT_READ_WRITE,
  RISCV64_LINUX_SYSCALLS,
} from "../../target/syscalls.js";
import { RISCV_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const WORD = TERA_POINTER_BYTES;
const COUNT_BYTES = TERA_COUNT_BYTES;
const RECORD_SHIFT = TERA_CLASS_RECORD_SHIFT;
const COUNT_SHIFT = TERA_COUNT_SHIFT;
const POINTER_SHIFT = TERA_ROOT_SLOT_SHIFT;
const LINUX_EXIT = RISCV64_LINUX_SYSCALLS.exit;
const LINUX_MMAP = RISCV64_LINUX_SYSCALLS.mmap;
const LINUX_PROT_READ_WRITE = PROT_READ_WRITE;
const LINUX_MAP_FLAGS = RISCV64_LINUX_SYSCALLS.mapFlags;

export const ROOT_FRAME_REGISTER = "t5";
export const ROOT_COUNT_REGISTER = "t6";
export const ROOT_ENTRY_BYTES = TERA_ROOT_ENTRY_BYTES;
export const ROOT_SLOT_SHIFT = TERA_ROOT_SLOT_SHIFT;

function reader(builder: MachineRoutineBuilder) {
  return (name: string, width = WORD): RegisterOperand => builder.read(name, width);
}

function writer(builder: MachineRoutineBuilder) {
  return (name: string, width = WORD): RegisterOperand => builder.write(name, width);
}

function loadGlobal(
  builder: MachineRoutineBuilder,
  destination: string,
  symbol: string,
  width: number,
  scratch: string,
): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("lla", w(scratch), sym(symbol))
    .emit(width === WORD ? "ld" : "lwu", w(destination), mem(width, { base: r(scratch) }));
}

function storeGlobal(
  builder: MachineRoutineBuilder,
  source: string,
  symbol: string,
  scratch: string,
): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("lla", w(scratch), sym(symbol))
    .emit("sd", r(source), mem(WORD, { base: r(scratch) }));
}

function loadContext(
  builder: MachineRoutineBuilder,
  destination: string,
  field: TeraContextField,
  scratch: string,
): void {
  const declared = TERA_CONTEXT.field(field);
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("lla", w(scratch), sym(TERA_CONTEXT.symbol))
    .emit(
      declared.bytes === WORD ? "ld" : "lwu",
      w(destination),
      mem(declared.bytes, { base: r(scratch), displacement: declared.offset }),
    );
}

function storeContext(
  builder: MachineRoutineBuilder,
  source: string,
  field: TeraContextField,
  scratch: string,
): void {
  const declared = TERA_CONTEXT.field(field);
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("lla", w(scratch), sym(TERA_CONTEXT.symbol))
    .emit(
      declared.bytes === WORD ? "sd" : "sw",
      r(source),
      mem(declared.bytes, { base: r(scratch), displacement: declared.offset }),
    );
}

function blockSize(builder: MachineRoutineBuilder, block: string, size: string): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("lwu", w(size), mem(COUNT_BYTES, { base: r(block), displacement: CLASS_FLAGS_OFFSET }))
    .emit("andi", w(size), r(size), imm(CLEAR_MARK));
}

function marked(
  builder: MachineRoutineBuilder,
  block: string,
  scratch: string,
): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("lwu", w(scratch), mem(COUNT_BYTES, { base: r(block), displacement: CLASS_FLAGS_OFFSET }))
    .emit("andi", w(scratch), r(scratch), imm(TERA_MARK_FLAG));
}

function setMark(builder: MachineRoutineBuilder, block: string, scratch: string): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("lwu", w(scratch), mem(COUNT_BYTES, { base: r(block), displacement: CLASS_FLAGS_OFFSET }))
    .emit("ori", w(scratch), r(scratch), imm(TERA_MARK_FLAG))
    .emit("sw", r(scratch), mem(COUNT_BYTES, { base: r(block), displacement: CLASS_FLAGS_OFFSET }));
}

function markPass(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("li", w("a0"), imm(0))
    .emit("li", w("t0"), imm(0));
  loadContext(builder, "a1", "arenaBase", "t2");
  builder.at("scan");
  loadContext(builder, "t1", "arenaCursor", "t2");
  builder
    .to("bgeu", "done", r("t0"), r("t1"))
    .emit("add", w("a2"), r("a1"), r("t0"))
    .emit("lwu", w("t1"), mem(COUNT_BYTES, { base: r("a2"), displacement: CLASS_SHAPE_ID_OFFSET }))
    .to("beqz", "advance", r("t1"));
  marked(builder, "a2", "t2");
  builder.to("beqz", "advance", r("t2"))
    .emit("slli", w("t1"), r("t1"), imm(RECORD_SHIFT))
    .emit("lla", w("t2"), sym(TERA_CLASS_RECORD.symbol))
    .emit("add", w("t2"), r("t2"), r("t1"))
    .emit("lwu", w("a4"), mem(COUNT_BYTES, { base: r("t2"), displacement: TERA_CLASS_RECORD.offsetOf("tailReferences") }))
    .emit("lwu", w("t3"), mem(COUNT_BYTES, { base: r("t2"), displacement: TERA_CLASS_RECORD.offsetOf("fieldStart") }))
    .emit("lwu", w("t4"), mem(COUNT_BYTES, { base: r("t2"), displacement: TERA_CLASS_RECORD.offsetOf("fieldCount") }))
    .emit("lla", w("t2"), sym(TERA_CLASS_FIELDS.symbol))
    .emit("slli", w("t3"), r("t3"), imm(COUNT_SHIFT))
    .emit("add", w("t3"), r("t2"), r("t3"))
    .to("beqz", "counted", r("a4"));
  blockSize(builder, "a2", "t4");
  builder
    .emit("addi", w("t4"), r("t4"), imm(-BUFFER_ELEMENTS_OFFSET))
    .emit("srli", w("t4"), r("t4"), imm(POINTER_SHIFT))
    .at("counted")
    .emit("li", w("a3"), imm(0))
    .at("field")
    .to("bgeu", "advance", r("a3"), r("t4"))
    .to("beqz", "listed", r("a4"))
    .emit("slli", w("t2"), r("a3"), imm(POINTER_SHIFT))
    .emit("addi", w("t2"), r("t2"), imm(BUFFER_ELEMENTS_OFFSET))
    .to("j", "reference")
    .at("listed")
    .emit("slli", w("t2"), r("a3"), imm(COUNT_SHIFT))
    .emit("add", w("t2"), r("t3"), r("t2"))
    .emit("lwu", w("t2"), mem(COUNT_BYTES, { base: r("t2") }))
    .at("reference")
    .emit("add", w("t2"), r("a2"), r("t2"))
    .emit("ld", w("t2"), mem(WORD, { base: r("t2") }))
    .to("beqz", "next", r("t2"));
  marked(builder, "t2", "t1");
  builder.to("bnez", "next", r("t1"));
  setMark(builder, "t2", "t1");
  builder
    .emit("li", w("a0"), imm(1))
    .at("next")
    .emit("addi", w("a3"), r("a3"), imm(1))
    .to("j", "field")
    .at("advance");
  blockSize(builder, "a2", "t1");
  builder
    .emit("add", w("t0"), r("t0"), r("t1"))
    .to("j", "scan")
    .at("done")
    .ret();
}

function unlink(builder: MachineRoutineBuilder, label: string): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("ld", w("t2"), mem(WORD, { base: r("a2"), displacement: CLASS_HEADER_BYTES }))
    .to("bnez", `${label}.chain`, r("a3"));
  storeContext(builder, "t2", "freeHead", "t1");
  builder
    .to("j", `${label}.done`)
    .at(`${label}.chain`)
    .emit("sd", r("t2"), mem(WORD, { base: r("a3"), displacement: CLASS_HEADER_BYTES }))
    .at(`${label}.done`);
}

function sweep(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder.emit("li", w("t2"), imm(0));
  storeContext(builder, "t2", "freeHead", "t1");
  builder.emit("li", w("t0"), imm(0));
  loadContext(builder, "a1", "arenaBase", "t2");
  builder.at("scan");
  loadContext(builder, "t1", "arenaCursor", "t2");
  builder
    .to("bgeu", "done", r("t0"), r("t1"))
    .emit("add", w("a2"), r("a1"), r("t0"))
    .emit("lwu", w("t1"), mem(COUNT_BYTES, { base: r("a2"), displacement: CLASS_SHAPE_ID_OFFSET }))
    .to("beqz", "dead", r("t1"));
  marked(builder, "a2", "t2");
  builder.to("beqz", "dead", r("t2"))
    .emit("lwu", w("t2"), mem(COUNT_BYTES, { base: r("a2"), displacement: CLASS_FLAGS_OFFSET }))
    .emit("andi", w("t2"), r("t2"), imm(~TERA_MARK_FLAG))
    .emit("sw", r("t2"), mem(COUNT_BYTES, { base: r("a2"), displacement: CLASS_FLAGS_OFFSET }));
  blockSize(builder, "a2", "t1");
  builder
    .emit("add", w("t0"), r("t0"), r("t1"))
    .to("j", "scan")
    .at("dead")
    .emit("mv", w("a4"), r("t0"))
    .emit("li", w("a5"), imm(0))
    .at("run");
  loadContext(builder, "t1", "arenaCursor", "t2");
  builder
    .to("bgeu", "linked", r("a4"), r("t1"))
    .emit("add", w("a3"), r("a1"), r("a4"))
    .emit("lwu", w("t1"), mem(COUNT_BYTES, { base: r("a3"), displacement: CLASS_SHAPE_ID_OFFSET }))
    .to("beqz", "join", r("t1"));
  marked(builder, "a3", "t2");
  builder.to("bnez", "linked", r("t2")).at("join");
  blockSize(builder, "a3", "t1");
  builder
    .emit("add", w("a5"), r("a5"), r("t1"))
    .emit("add", w("a4"), r("a4"), r("t1"))
    .to("j", "run")
    .at("linked")
    .emit("li", w("t1"), imm(TERA_FREE_SHAPE_ID))
    .emit("sw", r("t1"), mem(COUNT_BYTES, { base: r("a2"), displacement: CLASS_SHAPE_ID_OFFSET }))
    .emit("sw", r("a5"), mem(COUNT_BYTES, { base: r("a2"), displacement: CLASS_FLAGS_OFFSET }))
    .emit("li", w("t1"), imm(FREE_BLOCK_BYTES))
    .to("bltu", "skip", r("a5"), r("t1"));
  loadContext(builder, "t2", "freeHead", "t1");
  builder.emit("sd", r("t2"), mem(WORD, { base: r("a2"), displacement: CLASS_HEADER_BYTES }));
  storeContext(builder, "a2", "freeHead", "t1");
  builder
    .at("skip")
    .emit("mv", w("t0"), r("a4"))
    .to("j", "scan")
    .at("done")
    .ret();
}

const RETURN_SLOT = 16;

function collect(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("addi", w("sp"), r("sp"), imm(-RETURN_SLOT))
    .emit("sd", r("ra"), mem(WORD, { base: r("sp") }))
    .emit("li", w("s1"), imm(0));
  builder.emit("sd", r("s1"), mem(WORD, { base: r("sp"), displacement: WORD }));
  builder.emit("li", w("a4"), imm(0));
  loadContext(builder, "a5", "rootCount", "t1");
  builder
    .at("roots")
    .to("bgeu", "statics", r("a4"), r("a5"));
  loadContext(builder, "t1", "rootsBase", "t2");
  builder
    .emit("slli", w("t2"), r("a4"), imm(TERA_ROOT_SLOT_SHIFT))
    .emit("add", w("t1"), r("t1"), r("t2"))
    .emit("ld", w("t1"), mem(WORD, { base: r("t1") }))
    .to("beqz", "roots.next", r("t1"));
  setMark(builder, "t1", "t2");
  builder
    .at("roots.next")
    .emit("addi", w("a4"), r("a4"), imm(1))
    .to("j", "roots")
    .at("statics")
    .emit("li", w("a4"), imm(0));
  loadGlobal(builder, "a5", TERA_STATIC_ROOT_COUNT.symbol, COUNT_BYTES, "t1");
  builder
    .at("static")
    .to("bgeu", "queued", r("a4"), r("a5"))
    .emit("lla", w("t1"), sym(TERA_STATIC_ROOTS.symbol))
    .emit("slli", w("t2"), r("a4"), imm(COUNT_SHIFT))
    .emit("add", w("t1"), r("t1"), r("t2"))
    .emit("lwu", w("t1"), mem(COUNT_BYTES, { base: r("t1") }))
    .emit("lla", w("t2"), sym(TERA_STATICS.symbol))
    .emit("add", w("t1"), r("t2"), r("t1"))
    .emit("ld", w("t1"), mem(WORD, { base: r("t1") }))
    .to("beqz", "static.next", r("t1"));
  setMark(builder, "t1", "t2");
  builder
    .at("static.next")
    .emit("addi", w("a4"), r("a4"), imm(1))
    .to("j", "static")
    .at("queued");
  loadContext(builder, "t1", "queueHead", "t2");
  builder.to("beqz", "rejected", r("t1"));
  setMark(builder, "t1", "t2");
  builder.at("rejected");
  loadContext(builder, "t1", "rejectedHead", "t2");
  builder.to("beqz", "reported", r("t1"));
  setMark(builder, "t1", "t2");
  builder.at("reported");
  loadContext(builder, "t1", "rejectedText", "t2");
  builder.to("beqz", "propagate", r("t1"));
  setMark(builder, "t1", "t2");
  builder
    .at("propagate")
    .callSymbol(RISCV_RUNTIME_SYMBOLS.markPass)
    .to("bnez", "propagate", r("a0"))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.sweep)
    .emit("ld", w("ra"), mem(WORD, { base: r("sp") }))
    .emit("addi", w("sp"), r("sp"), imm(RETURN_SLOT))
    .ret();
}

function take(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder.emit("mv", w("a1"), r("a0")).emit("li", w("a3"), imm(0));
  loadContext(builder, "a2", "freeHead", "t1");
  builder
    .at("scan")
    .to("beqz", "none", r("a2"))
    .emit("lwu", w("t0"), mem(COUNT_BYTES, { base: r("a2"), displacement: CLASS_FLAGS_OFFSET }))
    .to("bltu", "next", r("t0"), r("a1"))
    .emit("sub", w("t1"), r("t0"), r("a1"))
    .to("beqz", "exact", r("t1"))
    .emit("li", w("t2"), imm(FREE_BLOCK_BYTES))
    .to("bltu", "next", r("t1"), r("t2"));
  unlink(builder, "split");
  builder
    .emit("add", w("a6"), r("a2"), r("a1"))
    .emit("li", w("t0"), imm(TERA_FREE_SHAPE_ID))
    .emit("sw", r("t0"), mem(COUNT_BYTES, { base: r("a6"), displacement: CLASS_SHAPE_ID_OFFSET }))
    .emit("sw", r("t1"), mem(COUNT_BYTES, { base: r("a6"), displacement: CLASS_FLAGS_OFFSET }));
  loadContext(builder, "t2", "freeHead", "t0");
  builder.emit("sd", r("t2"), mem(WORD, { base: r("a6"), displacement: CLASS_HEADER_BYTES }));
  storeContext(builder, "a6", "freeHead", "t0");
  builder.emit("mv", w("a0"), r("a2")).ret().at("exact");
  unlink(builder, "whole");
  builder
    .emit("mv", w("a0"), r("a2"))
    .ret()
    .at("next")
    .emit("mv", w("a3"), r("a2"))
    .emit("ld", w("a2"), mem(WORD, { base: r("a2"), displacement: CLASS_HEADER_BYTES }))
    .to("j", "scan")
    .at("none")
    .emit("li", w("a0"), imm(0))
    .ret();
}

function bump(builder: MachineRoutineBuilder, size: string, label: string): void {
  const r = reader(builder);
  const w = writer(builder);
  loadContext(builder, "t0", "arenaCursor", "t1");
  builder.emit("add", w("t1"), r("t0"), r(size));
  loadContext(builder, "t2", "arenaCommitted", "t2");
  builder.to("bgtu", `${label}.full`, r("t1"), r("t2"));
  storeContext(builder, "t1", "arenaCursor", "t2");
  loadContext(builder, "t1", "arenaBase", "t2");
  builder
    .emit("add", w("a0"), r("t1"), r("t0"))
    .to("j", `${label}.done`)
    .at(`${label}.full`)
    .emit("li", w("a0"), imm(0))
    .at(`${label}.done`);
}

function allocate(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("addi", w("sp"), r("sp"), imm(-RETURN_SLOT))
    .emit("sd", r("ra"), mem(WORD, { base: r("sp") }))
    .emit("mv", w("a6"), r("a0"))
    .emit("mv", w("a7"), r("a1"));
  bump(builder, "a6", "first");
  builder.to("bnez", "ready", r("a0")).emit("mv", w("a0"), r("a6")).callSymbol(RISCV_RUNTIME_SYMBOLS.take);
  builder
    .to("bnez", "ready", r("a0"))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.collect)
    .emit("mv", w("a0"), r("a6"))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.take)
    .to("bnez", "ready", r("a0"));
  bump(builder, "a6", "second");
  builder
    .to("bnez", "ready", r("a0"))
    .emit("mv", w("a0"), r("a6"))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.grow)
    .to("beqz", "exhausted", r("a0"));
  bump(builder, "a6", "third");
  builder
    .to("bnez", "ready", r("a0"))
    .at("exhausted")
    .emit("li", w("a0"), imm(TERA_EXIT_HEAP_EXHAUSTED))
    .emit("li", w("a7"), imm(LINUX_EXIT))
    .emit("ecall")
    .at("ready")
    .emit("mv", w("t0"), r("a0"))
    .emit("li", w("t1"), imm(0))
    .at("zero")
    .to("bgeu", "shaped", r("t1"), r("a6"))
    .emit("add", w("t2"), r("t0"), r("t1"))
    .emit("sd", r("zero"), mem(WORD, { base: r("t2") }))
    .emit("addi", w("t1"), r("t1"), imm(WORD))
    .to("j", "zero")
    .at("shaped")
    .emit("sw", r("a7"), mem(COUNT_BYTES, { base: r("t0"), displacement: CLASS_SHAPE_ID_OFFSET }))
    .emit("sw", r("a6"), mem(COUNT_BYTES, { base: r("t0"), displacement: CLASS_FLAGS_OFFSET }))
    .emit("mv", w("a0"), r("t0"))
    .emit("ld", w("ra"), mem(WORD, { base: r("sp") }))
    .emit("addi", w("sp"), r("sp"), imm(RETURN_SLOT))
    .ret();
}

function reserve(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  const point = (symbol: string, field: TeraContextField): void => {
    builder.emit("lla", w("t0"), sym(symbol));
    storeContext(builder, "t0", field, "t1");
  };
  point(TERA_ROOTS.symbol, "rootsBase");
  point(TERA_MARKS.symbol, "marksBase");
  loadContext(builder, "a1", "arenaReserved", "t0");
  builder
    .emit("li", w("a0"), imm(0))
    .emit("li", w("a2"), imm(LINUX_PROT_READ_WRITE))
    .emit("li", w("a3"), imm(LINUX_MAP_FLAGS))
    .emit("li", w("a4"), imm(MMAP_NO_FILE))
    .emit("li", w("a5"), imm(0))
    .emit("li", w("a7"), imm(LINUX_MMAP))
    .emit("ecall")
    .emit("li", w("t0"), imm(MMAP_ERROR_LIMIT))
    .to("bltu", "mapped", r("a0"), r("t0"))
    .emit("li", w("a0"), imm(TERA_EXIT_HEAP_EXHAUSTED))
    .emit("li", w("a7"), imm(LINUX_EXIT))
    .emit("ecall")
    .at("mapped");
  storeContext(builder, "a0", "arenaBase", "t0");
  builder.emit("li", w("t0"), imm(TERA_HEAP_COMMIT_BYTES));
  loadContext(builder, "t1", "arenaReserved", "t2");
  builder.to("bgeu", "sized", r("t1"), r("t0")).emit("mv", w("t0"), r("t1")).at("sized");
  storeContext(builder, "t0", "arenaCommitted", "t1");
  builder.ret();
}

function grow(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  loadContext(builder, "t0", "arenaCursor", "t3");
  builder.emit("add", w("t0"), r("t0"), r("a0"));
  loadContext(builder, "t1", "arenaCommitted", "t3");
  builder
    .emit("add", w("t1"), r("t1"), r("t1"))
    .to("bgeu", "covers", r("t1"), r("t0"))
    .emit("mv", w("t1"), r("t0"))
    .at("covers");
  loadContext(builder, "t2", "arenaReserved", "t3");
  builder.to("bgeu", "fits", r("t2"), r("t1")).emit("mv", w("t1"), r("t2")).at("fits");
  loadContext(builder, "t2", "arenaCommitted", "t3");
  builder.to("bgeu", "none", r("t2"), r("t1"));
  storeContext(builder, "t1", "arenaCommitted", "t3");
  builder
    .emit("li", w("a0"), imm(1))
    .ret()
    .at("none")
    .emit("li", w("a0"), imm(0))
    .ret();
}

function enterRoots(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  const frame = ROOT_FRAME_REGISTER;
  const count = ROOT_COUNT_REGISTER;
  const rootCount = TERA_CONTEXT.field("rootCount");
  builder
    .emit("lla", w(frame), sym(TERA_CONTEXT.symbol))
    .emit("ld", w("t0"), mem(WORD, { base: r(frame), displacement: rootCount.offset }))
    .emit("add", w("t1"), r("t0"), r(count))
    .emit("li", w("t2"), imm(TERA_ROOT_CAPACITY))
    .to("bgtu", "overflow", r("t1"), r("t2"))
    .emit("sd", r("t1"), mem(WORD, { base: r(frame), displacement: rootCount.offset }));
  loadContext(builder, frame, "rootsBase", "t1");
  builder
    .emit("slli", w("t1"), r("t0"), imm(TERA_ROOT_SLOT_SHIFT))
    .emit("add", w(frame), r(frame), r("t1"))
    .emit("li", w("t0"), imm(0))
    .at("zero")
    .to("bgeu", "done", r("t0"), r(count))
    .emit("slli", w("t1"), r("t0"), imm(TERA_ROOT_SLOT_SHIFT))
    .emit("add", w("t1"), r(frame), r("t1"))
    .emit("sd", r("zero"), mem(WORD, { base: r("t1") }))
    .emit("addi", w("t0"), r("t0"), imm(1))
    .to("j", "zero")
    .at("done")
    .ret()
    .at("overflow")
    .emit("li", w("a0"), imm(TERA_EXIT_HEAP_EXHAUSTED))
    .emit("li", w("a7"), imm(LINUX_EXIT))
    .emit("ecall");
}

const RESERVE_SLOTS = ["link", "array", "stride", "capacity"] as const;
const RESERVE_FRAME = RESERVE_SLOTS.length * WORD;

function arrayReserve(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  const spill = (slot: (typeof RESERVE_SLOTS)[number]) =>
    mem(WORD, { base: r("sp"), displacement: RESERVE_SLOTS.indexOf(slot) * WORD });
  builder
    .emit("addi", w("sp"), r("sp"), imm(-RESERVE_FRAME))
    .emit("sd", r("ra"), spill("link"))
    .emit("sd", r("a0"), spill("array"))
    .emit("sd", r("a2"), spill("stride"))
    .emit("lwu", w("t0"), mem(COUNT_BYTES, { base: r("a0"), displacement: ARRAY_LENGTH_OFFSET }))
    .emit("lwu", w("t1"), mem(COUNT_BYTES, { base: r("a0"), displacement: ARRAY_CAPACITY_OFFSET }))
    .to("bltu", "keep", r("t0"), r("t1"))
    .to("bnez", "double", r("t1"))
    .emit("li", w("t1"), imm(ARRAY_INITIAL_CAPACITY))
    .to("j", "sized")
    .at("double")
    .emit("slli", w("t1"), r("t1"), imm(GROWTH_SHIFT))
    .at("sized")
    .emit("sd", r("t1"), spill("capacity"))
    .emit("mul", w("t2"), r("t1"), r("a2"))
    .emit("addi", w("t2"), r("t2"), imm(BUFFER_ELEMENTS_OFFSET + ALIGNMENT_ROUNDING))
    .emit("andi", w("t2"), r("t2"), imm(-CLASS_ALIGNMENT_BYTES))
    .emit("mv", w("a0"), r("t2"))
    .callSymbol(RISCV_RUNTIME_SYMBOLS.allocate)
    .emit("ld", w("t0"), spill("array"))
    .emit("ld", w("t1"), spill("stride"))
    .emit("lwu", w("t2"), mem(COUNT_BYTES, { base: r("t0"), displacement: ARRAY_LENGTH_OFFSET }))
    .emit("mul", w("t2"), r("t2"), r("t1"))
    .emit("addi", w("t2"), r("t2"), imm(ALIGNMENT_ROUNDING))
    .emit("andi", w("t2"), r("t2"), imm(-CLASS_ALIGNMENT_BYTES))
    .emit("ld", w("t3"), mem(WORD, { base: r("t0"), displacement: ARRAY_ELEMENTS_OFFSET }))
    .emit("li", w("t4"), imm(0))
    .at("copy")
    .to("bgeu", "copied", r("t4"), r("t2"))
    .emit("add", w("a2"), r("t3"), r("t4"))
    .emit("ld", w("a3"), mem(WORD, { base: r("a2"), displacement: BUFFER_ELEMENTS_OFFSET }))
    .emit("add", w("a2"), r("a0"), r("t4"))
    .emit("sd", r("a3"), mem(WORD, { base: r("a2"), displacement: BUFFER_ELEMENTS_OFFSET }))
    .emit("addi", w("t4"), r("t4"), imm(WORD))
    .to("j", "copy")
    .at("copied")
    .emit("ld", w("t1"), spill("capacity"))
    .emit("sw", r("t1"), mem(COUNT_BYTES, { base: r("t0"), displacement: ARRAY_CAPACITY_OFFSET }))
    .emit("sd", r("a0"), mem(WORD, { base: r("t0"), displacement: ARRAY_ELEMENTS_OFFSET }))
    .to("j", "done")
    .at("keep")
    .emit("ld", w("a0"), mem(WORD, { base: r("a0"), displacement: ARRAY_ELEMENTS_OFFSET }))
    .at("done")
    .emit("ld", w("ra"), spill("link"))
    .emit("addi", w("sp"), r("sp"), imm(RESERVE_FRAME))
    .ret();
}

export function riscvHeapRoutines(): ReadonlyMap<
  string,
  (builder: MachineRoutineBuilder) => void
> {
  return new Map([
    [RISCV_RUNTIME_SYMBOLS.allocate, allocate],
    [RISCV_RUNTIME_SYMBOLS.arrayReserve, arrayReserve],
    [RISCV_RUNTIME_SYMBOLS.markPass, markPass],
    [RISCV_RUNTIME_SYMBOLS.sweep, sweep],
    [RISCV_RUNTIME_SYMBOLS.collect, collect],
    [RISCV_RUNTIME_SYMBOLS.take, take],
    [RISCV_RUNTIME_SYMBOLS.reserve, reserve],
    [RISCV_RUNTIME_SYMBOLS.grow, grow],
    [RISCV_RUNTIME_SYMBOLS.enterRoots, enterRoots],
  ]);
}
