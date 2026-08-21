import type { RuntimeAbi } from "../../target/abi.js";
import { imm, mem, type MachineOperand } from "../../machine/ir.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
import { x64IntegerArgumentNames } from "./abi.js";
import { X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const RETURN_ADDRESS_BYTES = 8;

const LOWER_A = "a".codePointAt(0)!;
const LOWER_Z = "z".codePointAt(0)!;
const UPPER_A = "A".codePointAt(0)!;
const UPPER_Z = "Z".codePointAt(0)!;
const CASE_DISTANCE = LOWER_A - UPPER_A;

const SPACE = " ".codePointAt(0)!;
const FIRST_CONTROL_BLANK = "\t".codePointAt(0)!;
const LAST_CONTROL_BLANK = "\r".codePointAt(0)!;

const DESTINATION = "r10";
const CAPACITY = "r11";
const SOURCE = "rax";

type Emit = (builder: MachineRoutineBuilder) => void;

function argument(
  abi: RuntimeAbi,
  builder: MachineRoutineBuilder,
  index: number,
  width: number,
): MachineOperand {
  const names = x64IntegerArgumentNames(abi);
  const name = names[index];
  if (name !== undefined) return builder.read(name, width);
  const { shadowSpaceBytes, stackArgumentSlotBytes } = abi.callingConvention;
  const stacked = index - names.length;
  return mem(width, {
    base: builder.read("rsp", 8),
    displacement: RETURN_ADDRESS_BYTES + shadowSpaceBytes + stacked * stackArgumentSlotBytes,
  });
}

function loadArguments(
  abi: RuntimeAbi,
  builder: MachineRoutineBuilder,
  homes: readonly (readonly [string, number])[],
): void {
  homes.forEach(([register, width], index) => {
    builder.emit(
      width === 8 ? "movq" : "movl",
      builder.write(register, width),
      argument(abi, builder, index, width),
    );
  });
}

function measure(builder: MachineRoutineBuilder, base: string, out: string, tag: string): void {
  builder
    .emit("xorl", builder.write(out, 4), builder.read(out, 4))
    .at(`${tag}_measure`)
    .emit(
      "cmpb",
      mem(1, { base: builder.read(base, 8), index: builder.read(out, 8), scale: 1 }),
      imm(0),
    )
    .to("je", `${tag}_measured`)
    .emit("incq", builder.write(out, 8))
    .to("jmp", `${tag}_measure`)
    .at(`${tag}_measured`);
}

function blank(
  builder: MachineRoutineBuilder,
  value: string,
  onBlank: string,
  onText: string,
): void {
  builder
    .emit("cmpl", builder.read(value, 4), imm(SPACE))
    .to("je", onBlank)
    .emit("cmpl", builder.read(value, 4), imm(FIRST_CONTROL_BLANK))
    .to("jl", onText)
    .emit("cmpl", builder.read(value, 4), imm(LAST_CONTROL_BLANK))
    .to("jg", onText)
    .to("jmp", onBlank);
}

function clamp(
  builder: MachineRoutineBuilder,
  value: string,
  size: string,
  tag: string,
): void {
  builder
    .emit("testl", builder.read(value, 4), builder.read(value, 4))
    .to("jns", `${tag}_positive`)
    .emit("addl", builder.write(value, 4), builder.read(size, 4))
    .emit("testl", builder.read(value, 4), builder.read(value, 4))
    .to("jns", `${tag}_bounded`)
    .emit("xorl", builder.write(value, 4), builder.read(value, 4))
    .to("jmp", `${tag}_bounded`)
    .at(`${tag}_positive`)
    .emit("cmpl", builder.read(value, 4), builder.read(size, 4))
    .to("jle", `${tag}_bounded`)
    .emit("movl", builder.write(value, 4), builder.read(size, 4))
    .at(`${tag}_bounded`);
}

function returnDestination(builder: MachineRoutineBuilder): void {
  builder.emit("movq", builder.write("rax", 8), builder.read(DESTINATION, 8)).ret();
}

function stringCase(abi: RuntimeAbi, upper: boolean): Emit {
  const [low, high, shift] = upper
    ? [LOWER_A, LOWER_Z, "subl"]
    : [UPPER_A, UPPER_Z, "addl"];
  return (builder) => {
    loadArguments(abi, builder, [
      [DESTINATION, 8],
      [CAPACITY, 4],
      [SOURCE, 8],
    ]);
    builder
      .emit("movq", builder.write("r9", 8), builder.read(DESTINATION, 8))
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "done")
      .emit("decl", builder.write(CAPACITY, 4))
      .at("step")
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "terminate")
      .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read(SOURCE, 8) }))
      .emit("testb", builder.read("rcx", 1), builder.read("rcx", 1))
      .to("je", "terminate")
      .emit("cmpl", builder.read("rcx", 4), imm(low))
      .to("jl", "store")
      .emit("cmpl", builder.read("rcx", 4), imm(high))
      .to("jg", "store")
      .emit(shift, builder.write("rcx", 4), imm(CASE_DISTANCE))
      .at("store")
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), builder.read("rcx", 1))
      .emit("incq", builder.write("r9", 8))
      .emit("incq", builder.write(SOURCE, 8))
      .emit("decl", builder.write(CAPACITY, 4))
      .to("jmp", "step")
      .at("terminate")
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), imm(0))
      .at("done");
    returnDestination(builder);
  };
}

function stringTrim(abi: RuntimeAbi, lead: boolean, trail: boolean): Emit {
  return (builder) => {
    loadArguments(abi, builder, [
      [DESTINATION, 8],
      [CAPACITY, 4],
      [SOURCE, 8],
    ]);
    measure(builder, SOURCE, "rcx", "trim");
    builder.emit("xorl", builder.write("r9", 4), builder.read("r9", 4));
    if (lead) {
      builder
        .at("lead")
        .emit("cmpl", builder.read("r9", 4), builder.read("rcx", 4))
        .to("jge", "lead_done")
        .emit(
          "movzbl",
          builder.write("rdx", 4),
          mem(1, { base: builder.read(SOURCE, 8), index: builder.read("r9", 8), scale: 1 }),
        );
      blank(builder, "rdx", "lead_skip", "lead_done");
      builder
        .at("lead_skip")
        .emit("incl", builder.write("r9", 4))
        .to("jmp", "lead")
        .at("lead_done");
    }
    if (trail) {
      builder
        .at("trail")
        .emit("cmpl", builder.read("rcx", 4), builder.read("r9", 4))
        .to("jle", "trail_done")
        .emit("movl", builder.write("rdx", 4), builder.read("rcx", 4))
        .emit("decl", builder.write("rdx", 4))
        .emit(
          "movzbl",
          builder.write("rdx", 4),
          mem(1, { base: builder.read(SOURCE, 8), index: builder.read("rdx", 8), scale: 1 }),
        );
      blank(builder, "rdx", "trail_skip", "trail_done");
      builder
        .at("trail_skip")
        .emit("decl", builder.write("rcx", 4))
        .to("jmp", "trail")
        .at("trail_done");
    }
    builder
      .emit("subl", builder.write("rcx", 4), builder.read("r9", 4))
      .emit("addq", builder.write(SOURCE, 8), builder.read("r9", 8))
      .emit("movq", builder.write("r9", 8), builder.read(DESTINATION, 8))
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "done")
      .emit("decl", builder.write(CAPACITY, 4))
      .at("copy")
      .emit("testl", builder.read("rcx", 4), builder.read("rcx", 4))
      .to("jle", "terminate")
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "terminate")
      .emit("movzbl", builder.write("rdx", 4), mem(1, { base: builder.read(SOURCE, 8) }))
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), builder.read("rdx", 1))
      .emit("incq", builder.write("r9", 8))
      .emit("incq", builder.write(SOURCE, 8))
      .emit("decl", builder.write(CAPACITY, 4))
      .emit("decl", builder.write("rcx", 4))
      .to("jmp", "copy")
      .at("terminate")
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), imm(0))
      .at("done");
    returnDestination(builder);
  };
}

function stringSlice(abi: RuntimeAbi): Emit {
  return (builder) => {
    loadArguments(abi, builder, [
      [DESTINATION, 8],
      [CAPACITY, 4],
      [SOURCE, 8],
      ["r9", 4],
      ["rcx", 4],
    ]);
    measure(builder, SOURCE, "rdx", "slice");
    clamp(builder, "r9", "rdx", "from");
    clamp(builder, "rcx", "rdx", "to");
    builder
      .emit("subl", builder.write("rcx", 4), builder.read("r9", 4))
      .emit("addq", builder.write(SOURCE, 8), builder.read("r9", 8))
      .emit("movq", builder.write("rdx", 8), builder.read(DESTINATION, 8))
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "done")
      .emit("decl", builder.write(CAPACITY, 4))
      .at("copy")
      .emit("testl", builder.read("rcx", 4), builder.read("rcx", 4))
      .to("jle", "terminate")
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "terminate")
      .emit("movzbl", builder.write("r8", 4), mem(1, { base: builder.read(SOURCE, 8) }))
      .emit("movb", mem(1, { base: builder.read("rdx", 8) }), builder.read("r8", 1))
      .emit("incq", builder.write("rdx", 8))
      .emit("incq", builder.write(SOURCE, 8))
      .emit("decl", builder.write(CAPACITY, 4))
      .emit("decl", builder.write("rcx", 4))
      .to("jmp", "copy")
      .at("terminate")
      .emit("movb", mem(1, { base: builder.read("rdx", 8) }), imm(0))
      .at("done");
    returnDestination(builder);
  };
}

function stringRepeat(abi: RuntimeAbi): Emit {
  return (builder) => {
    loadArguments(abi, builder, [
      [DESTINATION, 8],
      [CAPACITY, 4],
      [SOURCE, 8],
      ["r8", 4],
    ]);
    builder
      .emit("movq", builder.write("r9", 8), builder.read(DESTINATION, 8))
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "done")
      .emit("decl", builder.write(CAPACITY, 4))
      .at("round")
      .emit("testl", builder.read("r8", 4), builder.read("r8", 4))
      .to("jle", "terminate")
      .emit("movq", builder.write("rdx", 8), builder.read(SOURCE, 8))
      .at("inner")
      .emit("cmpb", mem(1, { base: builder.read("rdx", 8) }), imm(0))
      .to("je", "next")
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "terminate")
      .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read("rdx", 8) }))
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), builder.read("rcx", 1))
      .emit("incq", builder.write("r9", 8))
      .emit("incq", builder.write("rdx", 8))
      .emit("decl", builder.write(CAPACITY, 4))
      .to("jmp", "inner")
      .at("next")
      .emit("decl", builder.write("r8", 4))
      .to("jmp", "round")
      .at("terminate")
      .emit("movb", mem(1, { base: builder.read("r9", 8) }), imm(0))
      .at("done");
    returnDestination(builder);
  };
}

function stringReplace(abi: RuntimeAbi, all: boolean): Emit {
  return (builder) => {
    loadArguments(abi, builder, [
      [DESTINATION, 8],
      [CAPACITY, 4],
      [SOURCE, 8],
      ["r9", 8],
      ["rcx", 8],
    ]);

    const putFresh = (label: string, next: string): void => {
      builder
        .emit("xorl", builder.write("rbx", 4), builder.read("rbx", 4))
        .at(label)
        .emit(
          "movzbl",
          builder.write("r12", 4),
          mem(1, { base: builder.read("rcx", 8), index: builder.read("rbx", 8), scale: 1 }),
        )
        .emit("testb", builder.read("r12", 1), builder.read("r12", 1))
        .to("je", next)
        .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
        .to("jle", "terminate")
        .emit("movb", mem(1, { base: builder.read("rdx", 8) }), builder.read("r12", 1))
        .emit("incq", builder.write("rdx", 8))
        .emit("incq", builder.write("rbx", 8))
        .emit("decl", builder.write(CAPACITY, 4))
        .to("jmp", label);
    };

    const putSource = (next: string): void => {
      builder
        .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
        .to("jle", "terminate")
        .emit("movzbl", builder.write("r12", 4), mem(1, { base: builder.read("r8", 8) }))
        .emit("movb", mem(1, { base: builder.read("rdx", 8) }), builder.read("r12", 1))
        .emit("incq", builder.write("rdx", 8))
        .emit("incq", builder.write("r8", 8))
        .emit("decl", builder.write(CAPACITY, 4))
        .to("jmp", next);
    };

    builder
      .emit("pushq", builder.read("rbx", 8))
      .emit("pushq", builder.read("r12", 8))
      .emit("movq", builder.write("rdx", 8), builder.read(DESTINATION, 8))
      .emit("movq", builder.write("r8", 8), builder.read(SOURCE, 8))
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "done")
      .emit("decl", builder.write(CAPACITY, 4))
      .emit("cmpb", mem(1, { base: builder.read("r9", 8) }), imm(0))
      .to("je", "gaps")
      .at("scan")
      .emit("cmpb", mem(1, { base: builder.read("r8", 8) }), imm(0))
      .to("je", "terminate")
      .emit("cmpb", mem(1, { base: builder.read("r9", 8) }), imm(0))
      .to("je", "keep")
      .emit("xorl", builder.write("rbx", 4), builder.read("rbx", 4))
      .at("match")
      .emit(
        "movzbl",
        builder.write("r12", 4),
        mem(1, { base: builder.read("r9", 8), index: builder.read("rbx", 8), scale: 1 }),
      )
      .emit("testb", builder.read("r12", 1), builder.read("r12", 1))
      .to("je", "matched")
      .emit(
        "cmpb",
        mem(1, { base: builder.read("r8", 8), index: builder.read("rbx", 8), scale: 1 }),
        builder.read("r12", 1),
      )
      .to("jne", "keep")
      .emit("incq", builder.write("rbx", 8))
      .to("jmp", "match")
      .at("matched");
    putFresh("put", "advance");
    builder
      .at("advance")
      .emit("xorl", builder.write("rbx", 4), builder.read("rbx", 4))
      .at("skip")
      .emit(
        "cmpb",
        mem(1, { base: builder.read("r9", 8), index: builder.read("rbx", 8), scale: 1 }),
        imm(0),
      )
      .to("je", "skipped")
      .emit("incq", builder.write("rbx", 8))
      .to("jmp", "skip")
      .at("skipped")
      .emit("addq", builder.write("r8", 8), builder.read("rbx", 8));
    if (!all) {
      builder.emit("addq", builder.write("r9", 8), builder.read("rbx", 8));
    }
    builder.to("jmp", "scan").at("keep");
    putSource("scan");

    builder.at("gaps");
    if (!all) putFresh("lead", "gapscan");
    builder
      .at("gapscan")
      .emit("cmpb", mem(1, { base: builder.read("r8", 8) }), imm(0))
      .to("je", "terminate");
    if (all) {
      builder
        .emit("cmpq", builder.read("r8", 8), builder.read(SOURCE, 8))
        .to("je", "gapput");
      putFresh("separate", "gapput");
    }
    builder.at("gapput");
    putSource("gapscan");

    builder
      .at("terminate")
      .emit("movb", mem(1, { base: builder.read("rdx", 8) }), imm(0))
      .at("done")
      .emit("popq", builder.write("r12", 8))
      .emit("popq", builder.write("rbx", 8));
    returnDestination(builder);
  };
}

type FindMode = "index" | "includes" | "prefix" | "suffix";

function stringFind(abi: RuntimeAbi, mode: FindMode): Emit {
  const anchored = mode === "prefix" || mode === "suffix";
  return (builder) => {
    loadArguments(abi, builder, [
      [SOURCE, 8],
      ["r10", 8],
    ]);
    measure(builder, SOURCE, "r11", "value");
    measure(builder, "r10", "r9", "needle");
    builder.emit("movq", builder.write("rcx", 8), builder.read(SOURCE, 8));
    if (mode === "suffix") {
      builder
        .emit("movl", builder.write("rdx", 4), builder.read("r11", 4))
        .emit("subl", builder.write("rdx", 4), builder.read("r9", 4))
        .to("js", "missing")
        .emit("addq", builder.write("rcx", 8), builder.read("rdx", 8));
    }
    builder
      .at("start")
      .emit("xorl", builder.write("rdx", 4), builder.read("rdx", 4))
      .at("compare")
      .emit("cmpl", builder.read("rdx", 4), builder.read("r9", 4))
      .to("jge", "found")
      .emit(
        "movzbl",
        builder.write("r8", 4),
        mem(1, { base: builder.read("r10", 8), index: builder.read("rdx", 8), scale: 1 }),
      )
      .emit(
        "cmpb",
        mem(1, { base: builder.read("rcx", 8), index: builder.read("rdx", 8), scale: 1 }),
        builder.read("r8", 1),
      )
      .to("jne", "advance")
      .emit("incl", builder.write("rdx", 4))
      .to("jmp", "compare")
      .at("advance");
    if (anchored) {
      builder.to("jmp", "missing");
    } else {
      builder
        .emit("cmpb", mem(1, { base: builder.read("rcx", 8) }), imm(0))
        .to("je", "missing")
        .emit("incq", builder.write("rcx", 8))
        .to("jmp", "start");
    }
    builder.at("found");
    if (mode === "index") {
      builder
        .emit("subq", builder.write("rcx", 8), builder.read(SOURCE, 8))
        .emit("movl", builder.write("rax", 4), builder.read("rcx", 4))
        .ret()
        .at("missing")
        .emit("movl", builder.write("rax", 4), imm(-1))
        .ret();
      return;
    }
    builder
      .emit("movl", builder.write("rax", 4), imm(1))
      .ret()
      .at("missing")
      .emit("xorl", builder.write("rax", 4), builder.read("rax", 4))
      .ret();
  };
}

const DIGIT_ZERO = "0".codePointAt(0)!;
const DIGIT_NINE = "9".codePointAt(0)!;
const MINUS = "-".codePointAt(0)!;
const PLUS = "+".codePointAt(0)!;
const POINT = ".".codePointAt(0)!;
const SMALL_E = "e".codePointAt(0)!;
const CAPITAL_E = "E".codePointAt(0)!;

const CURSOR = "r10";
const NEGATIVE = "r11";
const DIGITS = "r9";
const SCALE = "r8";
const VALUE = "xmm0";
const RADIX = "xmm1";
const SCRATCH = "xmm2";
const POWER = "xmm3";

function skipBlanks(builder: MachineRoutineBuilder): void {
  builder
    .at("skip")
    .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read(CURSOR, 8) }));
  blank(builder, "rcx", "skip_over", "signed");
  builder
    .at("skip_over")
    .emit("incq", builder.write(CURSOR, 8))
    .to("jmp", "skip")
    .at("signed");
}

function readSign(builder: MachineRoutineBuilder, flag: string, tag: string): void {
  builder
    .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read(CURSOR, 8) }))
    .emit("cmpl", builder.read("rcx", 4), imm(MINUS))
    .to("jne", `${tag}_plus`)
    .emit("movl", builder.write(flag, 4), imm(1))
    .emit("incq", builder.write(CURSOR, 8))
    .to("jmp", `${tag}_signed`)
    .at(`${tag}_plus`)
    .emit("cmpl", builder.read("rcx", 4), imm(PLUS))
    .to("jne", `${tag}_signed`)
    .emit("incq", builder.write(CURSOR, 8))
    .at(`${tag}_signed`);
}

function accumulateDigits(builder: MachineRoutineBuilder, tag: string, counts: string | null): void {
  builder
    .at(`${tag}_digit`)
    .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read(CURSOR, 8) }))
    .emit("cmpl", builder.read("rcx", 4), imm(DIGIT_ZERO))
    .to("jl", `${tag}_end`)
    .emit("cmpl", builder.read("rcx", 4), imm(DIGIT_NINE))
    .to("jg", `${tag}_end`)
    .emit("subl", builder.write("rcx", 4), imm(DIGIT_ZERO))
    .emit("mulsd", builder.write(VALUE, 8), builder.read(RADIX, 8))
    .emit("cvtsi2sdl", builder.write(SCRATCH, 8), builder.read("rcx", 4))
    .emit("addsd", builder.write(VALUE, 8), builder.read(SCRATCH, 8))
    .emit("incl", builder.write(DIGITS, 4));
  if (counts !== null) builder.emit("incl", builder.write(counts, 4));
  builder
    .emit("incq", builder.write(CURSOR, 8))
    .to("jmp", `${tag}_digit`)
    .at(`${tag}_end`);
}

function accumulateExponent(builder: MachineRoutineBuilder, total: string, tag: string): void {
  builder
    .at(`${tag}_digit`)
    .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read(CURSOR, 8) }))
    .emit("cmpl", builder.read("rcx", 4), imm(DIGIT_ZERO))
    .to("jl", `${tag}_end`)
    .emit("cmpl", builder.read("rcx", 4), imm(DIGIT_NINE))
    .to("jg", `${tag}_end`)
    .emit("subl", builder.write("rcx", 4), imm(DIGIT_ZERO))
    .emit("movl", builder.write("rax", 4), builder.read(total, 4))
    .emit("sall", builder.write(total, 4), imm(3))
    .emit("sall", builder.write("rax", 4), imm(1))
    .emit("addl", builder.write(total, 4), builder.read("rax", 4))
    .emit("addl", builder.write(total, 4), builder.read("rcx", 4))
    .emit("incq", builder.write(CURSOR, 8))
    .to("jmp", `${tag}_digit`)
    .at(`${tag}_end`);
}

function tenToThe(builder: MachineRoutineBuilder, exponent: string, tag: string): void {
  builder
    .emit("movl", builder.write("rcx", 4), imm(1))
    .emit("cvtsi2sdl", builder.write(POWER, 8), builder.read("rcx", 4))
    .at(`${tag}_power`)
    .emit("testl", builder.read(exponent, 4), builder.read(exponent, 4))
    .to("jle", `${tag}_raised`)
    .emit("mulsd", builder.write(POWER, 8), builder.read(RADIX, 8))
    .emit("decl", builder.write(exponent, 4))
    .to("jmp", `${tag}_power`)
    .at(`${tag}_raised`);
}

function parseNumber(abi: RuntimeAbi, fractional: boolean): Emit {
  return (builder) => {
    loadArguments(abi, builder, [[CURSOR, 8]]);
    builder
      .emit("xorpd", builder.write(VALUE, 8), builder.read(VALUE, 8))
      .emit("movl", builder.write("rcx", 4), imm(10))
      .emit("cvtsi2sdl", builder.write(RADIX, 8), builder.read("rcx", 4))
      .emit("xorl", builder.write(NEGATIVE, 4), builder.read(NEGATIVE, 4))
      .emit("xorl", builder.write(DIGITS, 4), builder.read(DIGITS, 4))
      .emit("xorl", builder.write(SCALE, 4), builder.read(SCALE, 4));
    skipBlanks(builder);
    readSign(builder, NEGATIVE, "value");
    accumulateDigits(builder, "whole", null);
    if (fractional) {
      builder
        .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read(CURSOR, 8) }))
        .emit("cmpl", builder.read("rcx", 4), imm(POINT))
        .to("jne", "exponent")
        .emit("incq", builder.write(CURSOR, 8));
      accumulateDigits(builder, "fraction", SCALE);
      builder
        .at("exponent")
        .emit("testl", builder.read(DIGITS, 4), builder.read(DIGITS, 4))
        .to("je", "nan");
      tenToThe(builder, SCALE, "fraction");
      builder.emit("divsd", builder.write(VALUE, 8), builder.read(POWER, 8));
      builder
        .emit("movzbl", builder.write("rcx", 4), mem(1, { base: builder.read(CURSOR, 8) }))
        .emit("cmpl", builder.read("rcx", 4), imm(SMALL_E))
        .to("je", "exponent_sign")
        .emit("cmpl", builder.read("rcx", 4), imm(CAPITAL_E))
        .to("jne", "signal")
        .at("exponent_sign")
        .emit("incq", builder.write(CURSOR, 8))
        .emit("xorl", builder.write("rdx", 4), builder.read("rdx", 4));
      readSign(builder, "rdx", "exponent");
      builder.emit("xorl", builder.write(SCALE, 4), builder.read(SCALE, 4));
      accumulateExponent(builder, SCALE, "exponent");
      tenToThe(builder, SCALE, "exponent");
      builder
        .emit("testl", builder.read("rdx", 4), builder.read("rdx", 4))
        .to("jne", "exponent_down")
        .emit("mulsd", builder.write(VALUE, 8), builder.read(POWER, 8))
        .to("jmp", "signal")
        .at("exponent_down")
        .emit("divsd", builder.write(VALUE, 8), builder.read(POWER, 8))
        .to("jmp", "signal");
    }
    builder
      .at("signal")
      .emit("testl", builder.read(DIGITS, 4), builder.read(DIGITS, 4))
      .to("je", "nan")
      .emit("testl", builder.read(NEGATIVE, 4), builder.read(NEGATIVE, 4))
      .to("je", "ready")
      .emit("xorpd", builder.write(SCRATCH, 8), builder.read(SCRATCH, 8))
      .emit("subsd", builder.write(SCRATCH, 8), builder.read(VALUE, 8))
      .emit("movapd", builder.write(VALUE, 8), builder.read(SCRATCH, 8))
      .at("ready")
      .ret()
      .at("nan")
      .emit("xorpd", builder.write(VALUE, 8), builder.read(VALUE, 8))
      .emit("divsd", builder.write(VALUE, 8), builder.read(VALUE, 8))
      .ret();
  };
}

export function x64TextMethodRoutines(
  abi: RuntimeAbi,
): readonly (readonly [string, Emit])[] {
  return [
    [X64_RUNTIME_SYMBOLS.stringUpper, stringCase(abi, true)],
    [X64_RUNTIME_SYMBOLS.stringLower, stringCase(abi, false)],
    [X64_RUNTIME_SYMBOLS.stringTrim, stringTrim(abi, true, true)],
    [X64_RUNTIME_SYMBOLS.stringTrimStart, stringTrim(abi, true, false)],
    [X64_RUNTIME_SYMBOLS.stringTrimEnd, stringTrim(abi, false, true)],
    [X64_RUNTIME_SYMBOLS.stringSlice, stringSlice(abi)],
    [X64_RUNTIME_SYMBOLS.stringRepeat, stringRepeat(abi)],
    [X64_RUNTIME_SYMBOLS.stringReplace, stringReplace(abi, false)],
    [X64_RUNTIME_SYMBOLS.stringReplaceAll, stringReplace(abi, true)],
    [X64_RUNTIME_SYMBOLS.stringIndexOf, stringFind(abi, "index")],
    [X64_RUNTIME_SYMBOLS.stringIncludes, stringFind(abi, "includes")],
    [X64_RUNTIME_SYMBOLS.stringStartsWith, stringFind(abi, "prefix")],
    [X64_RUNTIME_SYMBOLS.stringEndsWith, stringFind(abi, "suffix")],
    [X64_RUNTIME_SYMBOLS.parseInt, parseNumber(abi, false)],
    [X64_RUNTIME_SYMBOLS.parseFloat, parseNumber(abi, true)],
  ];
}
