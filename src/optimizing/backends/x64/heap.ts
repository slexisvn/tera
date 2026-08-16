import { imm, mem, type RegisterOperand } from "../../machine/ir.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
import { alignUp } from "../../mc/buffer.js";
import type { RuntimeAbi } from "../../target/abi.js";
import {
  ARRAY_CAPACITY_OFFSET,
  ARRAY_ELEMENTS_OFFSET,
  ARRAY_GROWTH_FACTOR,
  ARRAY_INITIAL_CAPACITY,
  ARRAY_LENGTH_OFFSET,
  BUFFER_ELEMENTS_OFFSET,
  CLASS_ALIGNMENT_BYTES,
  CLASS_FLAGS_OFFSET,
  CLASS_HEADER_BYTES,
  CLASS_SHAPE_ID_OFFSET,
} from "../../metadata/class-table.js";
import {
  TERA_CLASS_RECORD,
  TERA_CLASS_RECORD_SHIFT,
  TERA_CLASS_FIELDS,
  TERA_CONTEXT,
  TERA_COUNT_BYTES,
  TERA_FREE_SHAPE_ID,
  TERA_HEAP_COMMIT_BYTES,
  TERA_LINK_BYTES,
  TERA_MARK_FLAG,
  TERA_MARKS,
  TERA_POINTER_BYTES,
  TERA_ROOT_CAPACITY,
  TERA_ROOT_SLOT_SHIFT,
  TERA_ROOTS,
  TERA_STATIC_ROOT_COUNT,
  TERA_STATIC_ROOTS,
  TERA_STATICS,
  type TeraContextField,
} from "../../target/runtime-layout.js";
import { TERA_EXIT_HEAP_EXHAUSTED } from "../../target/faults.js";
import { x64IntegerArgumentNames } from "./abi.js";
import type { PlatformIo } from "./entry.js";
import { X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const POINTER_BYTES = TERA_POINTER_BYTES;
const COUNT_BYTES = TERA_COUNT_BYTES;
const FREE_BLOCK_BYTES = CLASS_HEADER_BYTES + TERA_LINK_BYTES;
const RECORD_SHIFT = TERA_CLASS_RECORD_SHIFT;
const COUNT_SHIFT = Math.log2(COUNT_BYTES);
const POINTER_SHIFT = TERA_ROOT_SLOT_SHIFT;
const CLEAR_MARK = -1 - TERA_MARK_FLAG;
const GROWTH_SHIFT = Math.log2(ARRAY_GROWTH_FACTOR);
const ALIGNMENT_ROUNDING = CLASS_ALIGNMENT_BYTES - 1;

export const ROOT_FRAME_REGISTER = "r10";
export const ROOT_COUNT_REGISTER = "r11";
const ROOT_SCRATCH = "rax";

function reader(builder: MachineRoutineBuilder) {
  return (name: string, width = POINTER_BYTES): RegisterOperand =>
    builder.read(name, width);
}

function writer(builder: MachineRoutineBuilder) {
  return (name: string, width = COUNT_BYTES): RegisterOperand =>
    builder.write(name, width);
}

function global(symbol: string, width: number) {
  return mem(width, { symbol });
}

export function contextField(name: TeraContextField) {
  const field = TERA_CONTEXT.field(name);
  return mem(field.bytes, {
    symbol: TERA_CONTEXT.symbol,
    displacement: field.offset,
  });
}

function at(base: string, displacement: number, builder: MachineRoutineBuilder, width: number) {
  return mem(width, { base: builder.read(base, POINTER_BYTES), displacement });
}

function indexed(
  base: string,
  index: string,
  scale: number,
  displacement: number,
  builder: MachineRoutineBuilder,
  width: number,
) {
  return mem(width, {
    base: builder.read(base, POINTER_BYTES),
    index: builder.read(index, POINTER_BYTES),
    scale,
    displacement,
  });
}

function blockSize(builder: MachineRoutineBuilder, block: string, size: string): void {
  const w = writer(builder);
  builder
    .emit("movl", w(size), at(block, CLASS_FLAGS_OFFSET, builder, COUNT_BYTES))
    .emit("andl", w(size), imm(CLEAR_MARK));
}

function markPass(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("pushq", r("rbx"))
    .emit("xorl", w("rax"), r("rax", COUNT_BYTES))
    .emit("xorl", w("r8"), r("r8", COUNT_BYTES))
    .at("scan")
    .emit("movq", w("rcx", POINTER_BYTES), contextField("arenaCursor"))
    .emit("cmpq", r("r8"), r("rcx"))
    .to("jae", "done")
    .emit("movq", w("r11", POINTER_BYTES), contextField("arenaBase"))
    .emit("leaq", w("r10", POINTER_BYTES), indexed("r11", "r8", 1, 0, builder, POINTER_BYTES))
    .emit("movl", w("rcx"), at("r10", CLASS_SHAPE_ID_OFFSET, builder, COUNT_BYTES))
    .emit("testl", r("rcx", COUNT_BYTES), r("rcx", COUNT_BYTES))
    .to("je", "advance")
    .emit("testl", at("r10", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
    .to("je", "advance")
    .emit("shlq", w("rcx", POINTER_BYTES), imm(RECORD_SHIFT))
    .emit("leaq", w("rdx", POINTER_BYTES), global(TERA_CLASS_RECORD.symbol, POINTER_BYTES))
    .emit(
      "movl",
      w("r11"),
      indexed("rdx", "rcx", 1, TERA_CLASS_RECORD.offsetOf("tailReferences"), builder, COUNT_BYTES),
    )
    .emit(
      "movl",
      w("r9"),
      indexed("rdx", "rcx", 1, TERA_CLASS_RECORD.offsetOf("fieldStart"), builder, COUNT_BYTES),
    )
    .emit(
      "movl",
      w("rcx"),
      indexed("rdx", "rcx", 1, TERA_CLASS_RECORD.offsetOf("fieldCount"), builder, COUNT_BYTES),
    )
    .emit("leaq", w("rdx", POINTER_BYTES), global(TERA_CLASS_FIELDS.symbol, POINTER_BYTES))
    .emit(
      "leaq",
      w("r9", POINTER_BYTES),
      indexed("rdx", "r9", COUNT_BYTES, 0, builder, POINTER_BYTES),
    )
    .emit("testl", r("r11", COUNT_BYTES), r("r11", COUNT_BYTES))
    .to("je", "counted");
  blockSize(builder, "r10", "rcx");
  builder
    .emit("subq", w("rcx", POINTER_BYTES), imm(BUFFER_ELEMENTS_OFFSET))
    .emit("shrq", w("rcx", POINTER_BYTES), imm(POINTER_SHIFT))
    .at("counted")
    .emit("xorl", w("rbx"), r("rbx", COUNT_BYTES))
    .at("field")
    .emit("cmpq", r("rbx"), r("rcx"))
    .to("jae", "advance")
    .emit("testl", r("r11", COUNT_BYTES), r("r11", COUNT_BYTES))
    .to("je", "listed")
    .emit("movq", w("rdx", POINTER_BYTES), r("rbx"))
    .emit("shlq", w("rdx", POINTER_BYTES), imm(POINTER_SHIFT))
    .emit("addq", w("rdx", POINTER_BYTES), imm(BUFFER_ELEMENTS_OFFSET))
    .to("jmp", "reference")
    .at("listed")
    .emit("movl", w("rdx"), indexed("r9", "rbx", COUNT_BYTES, 0, builder, COUNT_BYTES))
    .at("reference")
    .emit("movq", w("rdx", POINTER_BYTES), indexed("r10", "rdx", 1, 0, builder, POINTER_BYTES))
    .emit("testq", r("rdx"), r("rdx"))
    .to("je", "next")
    .emit("testl", at("rdx", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
    .to("jne", "next")
    .emit("orl", at("rdx", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
    .emit("movl", w("rax"), imm(1))
    .at("next")
    .emit("incq", w("rbx", POINTER_BYTES))
    .to("jmp", "field")
    .at("advance");
  blockSize(builder, "r10", "rdx");
  builder
    .emit("addq", w("r8", POINTER_BYTES), r("rdx"))
    .to("jmp", "scan")
    .at("done")
    .emit("popq", w("rbx", POINTER_BYTES))
    .ret();
}

function unlink(builder: MachineRoutineBuilder, label: string): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("movq", w("rdx", POINTER_BYTES), at("r10", CLASS_HEADER_BYTES, builder, POINTER_BYTES))
    .emit("testq", r("r9"), r("r9"))
    .to("jne", `${label}.chain`)
    .emit("movq", contextField("freeHead"), r("rdx"))
    .to("jmp", `${label}.done`)
    .at(`${label}.chain`)
    .emit("movq", at("r9", CLASS_HEADER_BYTES, builder, POINTER_BYTES), r("rdx"))
    .at(`${label}.done`);
}

function sweep(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("pushq", r("rbx"))
    .emit("xorl", w("r8"), r("r8", COUNT_BYTES))
    .emit("movq", contextField("freeHead"), r("r8"))
    .emit("movq", w("r11", POINTER_BYTES), contextField("arenaBase"))
    .at("scan")
    .emit("movq", w("rcx", POINTER_BYTES), contextField("arenaCursor"))
    .emit("cmpq", r("r8"), r("rcx"))
    .to("jae", "done")
    .emit("leaq", w("r10", POINTER_BYTES), indexed("r11", "r8", 1, 0, builder, POINTER_BYTES))
    .emit("movl", w("rcx"), at("r10", CLASS_SHAPE_ID_OFFSET, builder, COUNT_BYTES))
    .emit("testl", r("rcx", COUNT_BYTES), r("rcx", COUNT_BYTES))
    .to("je", "dead")
    .emit("testl", at("r10", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
    .to("je", "dead")
    .emit("andl", at("r10", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(CLEAR_MARK));
  blockSize(builder, "r10", "rdx");
  builder
    .emit("addq", w("r8", POINTER_BYTES), r("rdx"))
    .to("jmp", "scan")
    .at("dead")
    .emit("movq", w("rbx", POINTER_BYTES), r("r8"))
    .emit("xorl", w("rax"), r("rax", COUNT_BYTES))
    .at("run")
    .emit("movq", w("rcx", POINTER_BYTES), contextField("arenaCursor"))
    .emit("cmpq", r("rbx"), r("rcx"))
    .to("jae", "linked")
    .emit("leaq", w("r9", POINTER_BYTES), indexed("r11", "rbx", 1, 0, builder, POINTER_BYTES))
    .emit("movl", w("rcx"), at("r9", CLASS_SHAPE_ID_OFFSET, builder, COUNT_BYTES))
    .emit("testl", r("rcx", COUNT_BYTES), r("rcx", COUNT_BYTES))
    .to("je", "join")
    .emit("testl", at("r9", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
    .to("jne", "linked")
    .at("join");
  blockSize(builder, "r9", "rdx");
  builder
    .emit("addq", w("rax", POINTER_BYTES), r("rdx"))
    .emit("addq", w("rbx", POINTER_BYTES), r("rdx"))
    .to("jmp", "run")
    .at("linked")
    .emit(
      "movl",
      at("r10", CLASS_SHAPE_ID_OFFSET, builder, COUNT_BYTES),
      imm(TERA_FREE_SHAPE_ID),
    )
    .emit("movl", at("r10", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), r("rax", COUNT_BYTES))
    .emit("cmpq", r("rax"), imm(FREE_BLOCK_BYTES))
    .to("jb", "skip")
    .emit("movq", w("rdx", POINTER_BYTES), contextField("freeHead"))
    .emit("movq", at("r10", CLASS_HEADER_BYTES, builder, POINTER_BYTES), r("rdx"))
    .emit("movq", contextField("freeHead"), r("r10"))
    .at("skip")
    .emit("movq", w("r8", POINTER_BYTES), r("rbx"))
    .to("jmp", "scan")
    .at("done")
    .emit("popq", w("rbx", POINTER_BYTES))
    .ret();
}

function collect(abi: RuntimeAbi) {
  const frame = alignUp(abi.callingConvention.shadowSpaceBytes + POINTER_BYTES, 16);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("pushq", r("rbx"))
      .emit("pushq", r("r12"))
      .emit("subq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame))
      .emit("xorl", w("rbx"), r("rbx", COUNT_BYTES))
      .emit("movq", w("r12", POINTER_BYTES), contextField("rootCount"))
      .at("roots")
      .emit("cmpq", r("rbx"), r("r12"))
      .to("jae", "statics")
      .emit("movq", w("rax", POINTER_BYTES), contextField("rootsBase"))
      .emit(
        "movq",
        w("rax", POINTER_BYTES),
        indexed("rax", "rbx", POINTER_BYTES, 0, builder, POINTER_BYTES),
      )
      .emit("testq", r("rax"), r("rax"))
      .to("je", "roots.next")
      .emit("orl", at("rax", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
      .at("roots.next")
      .emit("incq", w("rbx", POINTER_BYTES))
      .to("jmp", "roots")
      .at("statics")
      .emit("xorl", w("rbx"), r("rbx", COUNT_BYTES))
      .emit("movl", w("r12"), global(TERA_STATIC_ROOT_COUNT.symbol, COUNT_BYTES))
      .at("static")
      .emit("cmpq", r("rbx"), r("r12"))
      .to("jae", "queued")
      .emit("leaq", w("rax", POINTER_BYTES), global(TERA_STATIC_ROOTS.symbol, POINTER_BYTES))
      .emit(
        "movl",
        w("rax"),
        indexed("rax", "rbx", COUNT_BYTES, 0, builder, COUNT_BYTES),
      )
      .emit("leaq", w("rcx", POINTER_BYTES), global(TERA_STATICS.symbol, POINTER_BYTES))
      .emit(
        "movq",
        w("rax", POINTER_BYTES),
        indexed("rcx", "rax", 1, 0, builder, POINTER_BYTES),
      )
      .emit("testq", r("rax"), r("rax"))
      .to("je", "static.next")
      .emit("orl", at("rax", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
      .at("static.next")
      .emit("incq", w("rbx", POINTER_BYTES))
      .to("jmp", "static")
      .at("queued")
      .emit("movq", w("rax", POINTER_BYTES), contextField("queueHead"))
      .emit("testq", r("rax"), r("rax"))
      .to("je", "rejected")
      .emit("orl", at("rax", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
      .at("rejected")
      .emit("movq", w("rax", POINTER_BYTES), contextField("rejectedHead"))
      .emit("testq", r("rax"), r("rax"))
      .to("je", "reported")
      .emit("orl", at("rax", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
      .at("reported")
      .emit("movq", w("rax", POINTER_BYTES), contextField("rejectedText"))
      .emit("testq", r("rax"), r("rax"))
      .to("je", "propagate")
      .emit("orl", at("rax", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), imm(TERA_MARK_FLAG))
      .at("propagate")
      .callSymbol(X64_RUNTIME_SYMBOLS.markPass)
      .emit("testl", r("rax", COUNT_BYTES), r("rax", COUNT_BYTES))
      .to("jne", "propagate")
      .callSymbol(X64_RUNTIME_SYMBOLS.sweep)
      .emit("addq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame))
      .emit("popq", w("r12", POINTER_BYTES))
      .emit("popq", w("rbx", POINTER_BYTES))
      .ret();
  };
}

function take(abi: RuntimeAbi) {
  const [size] = x64IntegerArgumentNames(abi);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("movq", w("r8", POINTER_BYTES), r(size!))
      .emit("xorl", w("r9"), r("r9", COUNT_BYTES))
      .emit("movq", w("r10", POINTER_BYTES), contextField("freeHead"))
      .at("scan")
      .emit("testq", r("r10"), r("r10"))
      .to("je", "none")
      .emit("movl", w("rax"), at("r10", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES))
      .emit("movq", w("rcx", POINTER_BYTES), r("rax"))
      .emit("subq", w("rcx", POINTER_BYTES), r("r8"))
      .to("je", "exact")
      .to("jb", "next")
      .emit("cmpq", r("rcx"), imm(FREE_BLOCK_BYTES))
      .to("jb", "next");
    unlink(builder, "split");
    builder
      .emit("leaq", w("r11", POINTER_BYTES), indexed("r10", "r8", 1, 0, builder, POINTER_BYTES))
      .emit(
        "movl",
        at("r11", CLASS_SHAPE_ID_OFFSET, builder, COUNT_BYTES),
        imm(TERA_FREE_SHAPE_ID),
      )
      .emit("movl", at("r11", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), r("rcx", COUNT_BYTES))
      .emit("movq", w("rdx", POINTER_BYTES), contextField("freeHead"))
      .emit("movq", at("r11", CLASS_HEADER_BYTES, builder, POINTER_BYTES), r("rdx"))
      .emit("movq", contextField("freeHead"), r("r11"))
      .emit("movq", w("rax", POINTER_BYTES), r("r10"))
      .ret()
      .at("exact");
    unlink(builder, "whole");
    builder
      .emit("movq", w("rax", POINTER_BYTES), r("r10"))
      .ret()
      .at("next")
      .emit("movq", w("r9", POINTER_BYTES), r("r10"))
      .emit("movq", w("r10", POINTER_BYTES), at("r10", CLASS_HEADER_BYTES, builder, POINTER_BYTES))
      .to("jmp", "scan")
      .at("none")
      .emit("xorl", w("rax"), r("rax", COUNT_BYTES))
      .ret();
  };
}

function bump(builder: MachineRoutineBuilder, size: string, label: string): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("movq", w("rax", POINTER_BYTES), contextField("arenaCursor"))
    .emit("movq", w("rcx", POINTER_BYTES), r("rax"))
    .emit("addq", w("rcx", POINTER_BYTES), r(size))
    .emit("cmpq", r("rcx"), contextField("arenaCommitted"))
    .to("ja", `${label}.full`)
    .emit("movq", contextField("arenaCursor"), r("rcx"))
    .emit("addq", w("rax", POINTER_BYTES), contextField("arenaBase"))
    .to("jmp", `${label}.done`)
    .at(`${label}.full`)
    .emit("xorl", w("rax"), r("rax", COUNT_BYTES))
    .at(`${label}.done`);
}

function reserveOnce(builder: MachineRoutineBuilder): void {
  const r = reader(builder);
  const w = writer(builder);
  builder
    .emit("movq", w("rax", POINTER_BYTES), contextField("arenaBase"))
    .emit("testq", r("rax"), r("rax"))
    .to("jne", "reserved")
    .callSymbol(X64_RUNTIME_SYMBOLS.reserve)
    .at("reserved");
}

function allocate(abi: RuntimeAbi, io: PlatformIo) {
  const [size, shape] = x64IntegerArgumentNames(abi);
  const frame = alignUp(abi.callingConvention.shadowSpaceBytes + POINTER_BYTES, 16);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("pushq", r("rbx"))
      .emit("pushq", r("r12"))
      .emit("subq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame))
      .emit("movq", w("rbx", POINTER_BYTES), r(size!))
      .emit("movl", w("r12"), r(shape!, COUNT_BYTES));
    reserveOnce(builder);
    bump(builder, "rbx", "first");
    builder
      .emit("testq", r("rax"), r("rax"))
      .to("jne", "ready")
      .emit("movq", w(size!, POINTER_BYTES), r("rbx"))
      .callSymbol(X64_RUNTIME_SYMBOLS.take)
      .emit("testq", r("rax"), r("rax"))
      .to("jne", "ready")
      .callSymbol(X64_RUNTIME_SYMBOLS.collect)
      .emit("movq", w(size!, POINTER_BYTES), r("rbx"))
      .callSymbol(X64_RUNTIME_SYMBOLS.take)
      .emit("testq", r("rax"), r("rax"))
      .to("jne", "ready");
    bump(builder, "rbx", "second");
    builder
      .emit("testq", r("rax"), r("rax"))
      .to("jne", "ready")
      .emit("movq", w(size!, POINTER_BYTES), r("rbx"))
      .callSymbol(X64_RUNTIME_SYMBOLS.grow)
      .emit("testq", r("rax"), r("rax"))
      .to("je", "exhausted");
    bump(builder, "rbx", "third");
    builder
      .emit("testq", r("rax"), r("rax"))
      .to("jne", "ready")
      .at("exhausted");
    io.exit(builder, imm(TERA_EXIT_HEAP_EXHAUSTED));
    builder
      .at("ready")
      .emit("movq", w("r10", POINTER_BYTES), r("rax"))
      .emit("xorl", w("rcx"), r("rcx", COUNT_BYTES))
      .at("zero")
      .emit("cmpq", r("rcx"), r("rbx"))
      .to("jae", "shaped")
      .emit("movq", indexed("r10", "rcx", 1, 0, builder, POINTER_BYTES), imm(0))
      .emit("addq", w("rcx", POINTER_BYTES), imm(POINTER_BYTES))
      .to("jmp", "zero")
      .at("shaped")
      .emit("movl", at("r10", CLASS_SHAPE_ID_OFFSET, builder, COUNT_BYTES), r("r12", COUNT_BYTES))
      .emit("movl", at("r10", CLASS_FLAGS_OFFSET, builder, COUNT_BYTES), r("rbx", COUNT_BYTES))
      .emit("movq", w("rax", POINTER_BYTES), r("r10"))
      .emit("addq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame))
      .emit("popq", w("r12", POINTER_BYTES))
      .emit("popq", w("rbx", POINTER_BYTES))
      .ret();
  };
}

function arrayReserve(abi: RuntimeAbi) {
  const [array, , stride] = x64IntegerArgumentNames(abi);
  const frame = alignUp(abi.callingConvention.shadowSpaceBytes + POINTER_BYTES, 16);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit("pushq", r("rbx"))
      .emit("pushq", r("r12"))
      .emit("pushq", r("r13"))
      .emit("pushq", r("r14"))
      .emit("subq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame))
      .emit("movq", w("rbx", POINTER_BYTES), r(array!))
      .emit("movl", w("r12"), r(stride!, COUNT_BYTES))
      .emit("movl", w("r14"), at("rbx", ARRAY_LENGTH_OFFSET, builder, COUNT_BYTES))
      .emit("movl", w("rax"), at("rbx", ARRAY_CAPACITY_OFFSET, builder, COUNT_BYTES))
      .emit("cmpl", r("r14", COUNT_BYTES), r("rax", COUNT_BYTES))
      .to("jl", "keep")
      .emit("movl", w("r13"), r("rax", COUNT_BYTES))
      .emit("testl", r("r13", COUNT_BYTES), r("r13", COUNT_BYTES))
      .to("jne", "double")
      .emit("movl", w("r13"), imm(ARRAY_INITIAL_CAPACITY))
      .to("jmp", "sized")
      .at("double")
      .emit("shlq", w("r13", POINTER_BYTES), imm(GROWTH_SHIFT))
      .at("sized")
      .emit("movq", w("rax", POINTER_BYTES), r("r13"))
      .emit("imulq", w("rax", POINTER_BYTES), r("r12"))
      .emit("addq", w("rax", POINTER_BYTES), imm(BUFFER_ELEMENTS_OFFSET + ALIGNMENT_ROUNDING))
      .emit("andq", w("rax", POINTER_BYTES), imm(-CLASS_ALIGNMENT_BYTES))
      .emit("movq", w(array!, POINTER_BYTES), r("rax"))
      .callSymbol(X64_RUNTIME_SYMBOLS.allocate)
      .emit("movq", w("rcx", POINTER_BYTES), at("rbx", ARRAY_ELEMENTS_OFFSET, builder, POINTER_BYTES))
      .emit("imulq", w("r14", POINTER_BYTES), r("r12"))
      .emit("addq", w("r14", POINTER_BYTES), imm(ALIGNMENT_ROUNDING))
      .emit("andq", w("r14", POINTER_BYTES), imm(-CLASS_ALIGNMENT_BYTES))
      .emit("xorl", w("r8"), r("r8", COUNT_BYTES))
      .at("copy")
      .emit("cmpq", r("r8"), r("r14"))
      .to("jae", "copied")
      .emit(
        "movq",
        w("r9", POINTER_BYTES),
        indexed("rcx", "r8", 1, BUFFER_ELEMENTS_OFFSET, builder, POINTER_BYTES),
      )
      .emit(
        "movq",
        indexed("rax", "r8", 1, BUFFER_ELEMENTS_OFFSET, builder, POINTER_BYTES),
        r("r9"),
      )
      .emit("addq", w("r8", POINTER_BYTES), imm(POINTER_BYTES))
      .to("jmp", "copy")
      .at("copied")
      .emit("movl", at("rbx", ARRAY_CAPACITY_OFFSET, builder, COUNT_BYTES), r("r13", COUNT_BYTES))
      .emit("movq", at("rbx", ARRAY_ELEMENTS_OFFSET, builder, POINTER_BYTES), r("rax"))
      .to("jmp", "done")
      .at("keep")
      .emit("movq", w("rax", POINTER_BYTES), at("rbx", ARRAY_ELEMENTS_OFFSET, builder, POINTER_BYTES))
      .at("done")
      .emit("addq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame))
      .emit("popq", w("r14", POINTER_BYTES))
      .emit("popq", w("r13", POINTER_BYTES))
      .emit("popq", w("r12", POINTER_BYTES))
      .emit("popq", w("rbx", POINTER_BYTES))
      .ret();
  };
}

const RESERVE_SIZE_REGISTER = "rbx";
const RESERVE_BASE_REGISTER = "r12";
const COMMIT_ADDRESS_REGISTER = "r10";

function calleeFrame(abi: RuntimeAbi, saved: number): number {
  const pushed = (1 + saved) * POINTER_BYTES;
  return alignUp(abi.callingConvention.shadowSpaceBytes + pushed, 16) - pushed;
}

function reserve(abi: RuntimeAbi, io: PlatformIo) {
  const frame = calleeFrame(abi, 2);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    const point = (symbol: string, field: TeraContextField): void => {
      builder
        .emit("leaq", w("rax", POINTER_BYTES), global(symbol, POINTER_BYTES))
        .emit("movq", contextField(field), r("rax"));
    };
    builder
      .emit("pushq", r(RESERVE_SIZE_REGISTER))
      .emit("pushq", r(RESERVE_BASE_REGISTER))
      .emit("subq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame));
    point(TERA_ROOTS.symbol, "rootsBase");
    point(TERA_MARKS.symbol, "marksBase");
    builder.emit(
      "movq",
      w(RESERVE_SIZE_REGISTER, POINTER_BYTES),
      contextField("arenaReserved"),
    );
    io.reserve(builder, RESERVE_SIZE_REGISTER, "rax");
    builder
      .emit("testq", r("rax"), r("rax"))
      .to("je", "failed")
      .emit("movq", contextField("arenaBase"), r("rax"))
      .emit("movq", w(RESERVE_BASE_REGISTER, POINTER_BYTES), r("rax"))
      .emit("movq", w(RESERVE_SIZE_REGISTER, POINTER_BYTES), imm(TERA_HEAP_COMMIT_BYTES))
      .emit("cmpq", r(RESERVE_SIZE_REGISTER), contextField("arenaReserved"))
      .to("jbe", "sized")
      .emit("movq", w(RESERVE_SIZE_REGISTER, POINTER_BYTES), contextField("arenaReserved"))
      .at("sized");
    io.commit(builder, RESERVE_BASE_REGISTER, RESERVE_SIZE_REGISTER, "rax");
    builder
      .emit("testq", r("rax"), r("rax"))
      .to("je", "failed")
      .emit("movq", contextField("arenaCommitted"), r(RESERVE_SIZE_REGISTER))
      .emit("addq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame))
      .emit("popq", w(RESERVE_BASE_REGISTER, POINTER_BYTES))
      .emit("popq", w(RESERVE_SIZE_REGISTER, POINTER_BYTES))
      .ret()
      .at("failed");
    io.exit(builder, imm(TERA_EXIT_HEAP_EXHAUSTED));
  };
}

function grow(abi: RuntimeAbi, io: PlatformIo) {
  const [size] = x64IntegerArgumentNames(abi);
  const wanted = RESERVE_SIZE_REGISTER;
  const frame = calleeFrame(abi, 1);
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder.emit("pushq", r(wanted));
    if (frame !== 0) {
      builder.emit("subq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame));
    }
    builder
      .emit("movq", w("rax", POINTER_BYTES), contextField("arenaCursor"))
      .emit("addq", w("rax", POINTER_BYTES), r(size!))
      .emit("movq", w(wanted, POINTER_BYTES), contextField("arenaCommitted"))
      .emit("addq", w(wanted, POINTER_BYTES), r(wanted))
      .emit("cmpq", r(wanted), r("rax"))
      .to("jae", "covers")
      .emit("movq", w(wanted, POINTER_BYTES), r("rax"))
      .at("covers")
      .emit("cmpq", r(wanted), contextField("arenaReserved"))
      .to("jbe", "fits")
      .emit("movq", w(wanted, POINTER_BYTES), contextField("arenaReserved"))
      .at("fits")
      .emit("cmpq", r(wanted), contextField("arenaCommitted"))
      .to("jbe", "none")
      .emit("movq", w(COMMIT_ADDRESS_REGISTER, POINTER_BYTES), contextField("arenaBase"));
    io.commit(builder, COMMIT_ADDRESS_REGISTER, wanted, "rax");
    builder
      .emit("testq", r("rax"), r("rax"))
      .to("je", "none")
      .emit("movq", contextField("arenaCommitted"), r(wanted))
      .to("jmp", "done")
      .at("none")
      .emit("xorl", w("rax"), r("rax", COUNT_BYTES))
      .at("done");
    if (frame !== 0) {
      builder.emit("addq", w(abi.stackPointer.name, POINTER_BYTES), imm(frame));
    }
    builder.emit("popq", w(wanted, POINTER_BYTES)).ret();
  };
}

function enterRoots(io: PlatformIo) {
  return (builder: MachineRoutineBuilder): void => {
    const r = reader(builder);
    const w = writer(builder);
    builder
      .emit(
        "movq",
        w(ROOT_FRAME_REGISTER, POINTER_BYTES),
        contextField("rootCount"),
      )
      .emit("movq", w(ROOT_SCRATCH, POINTER_BYTES), r(ROOT_FRAME_REGISTER))
      .emit("addq", w(ROOT_SCRATCH, POINTER_BYTES), r(ROOT_COUNT_REGISTER))
      .emit("cmpq", r(ROOT_SCRATCH), imm(TERA_ROOT_CAPACITY))
      .to("ja", "overflow")
      .emit("movq", contextField("rootCount"), r(ROOT_SCRATCH))
      .emit("movq", w(ROOT_SCRATCH, POINTER_BYTES), r(ROOT_FRAME_REGISTER))
      .emit(
        "leaq",
        w(ROOT_FRAME_REGISTER, POINTER_BYTES),
        global(TERA_ROOTS.symbol, POINTER_BYTES),
      )
      .emit(
        "leaq",
        w(ROOT_FRAME_REGISTER, POINTER_BYTES),
        indexed(ROOT_FRAME_REGISTER, ROOT_SCRATCH, POINTER_BYTES, 0, builder, POINTER_BYTES),
      )
      .emit("xorl", w(ROOT_SCRATCH), r(ROOT_SCRATCH, COUNT_BYTES))
      .at("zero")
      .emit("cmpq", r(ROOT_SCRATCH), r(ROOT_COUNT_REGISTER))
      .to("jae", "done")
      .emit(
        "movq",
        indexed(ROOT_FRAME_REGISTER, ROOT_SCRATCH, POINTER_BYTES, 0, builder, POINTER_BYTES),
        imm(0),
      )
      .emit("incq", w(ROOT_SCRATCH, POINTER_BYTES))
      .to("jmp", "zero")
      .at("done")
      .ret()
      .at("overflow");
    io.exit(builder, imm(TERA_EXIT_HEAP_EXHAUSTED));
  };
}

export function x64HeapRoutines(
  abi: RuntimeAbi,
  io: PlatformIo,
): ReadonlyMap<string, (builder: MachineRoutineBuilder) => void> {
  return new Map([
    [X64_RUNTIME_SYMBOLS.allocate, allocate(abi, io)],
    [X64_RUNTIME_SYMBOLS.arrayReserve, arrayReserve(abi)],
    [X64_RUNTIME_SYMBOLS.markPass, markPass],
    [X64_RUNTIME_SYMBOLS.sweep, sweep],
    [X64_RUNTIME_SYMBOLS.collect, collect(abi)],
    [X64_RUNTIME_SYMBOLS.take, take(abi)],
    [X64_RUNTIME_SYMBOLS.enterRoots, enterRoots(io)],
    [X64_RUNTIME_SYMBOLS.reserve, reserve(abi, io)],
    [X64_RUNTIME_SYMBOLS.grow, grow(abi, io)],
  ]);
}

export const ROOT_FRAME_BYTES = POINTER_BYTES;
export const ROOT_SLOT_SHIFT = POINTER_SHIFT;
export const ROOT_ENTRY_BYTES = POINTER_BYTES;
export { COUNT_SHIFT };
