import { TEXT_UNIT_BYTES, TEXT_UNIT_SHIFT } from "../../types/scalar.js";
import type { RuntimeAbi } from "../../target/abi.js";
import { imm, mem, type MachineOperand } from "../../machine/ir.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
import { x64IntegerArgumentNames } from "./abi.js";
import { X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";
import { reportTextOverflow } from "./text-overflow.js";

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
      "cmpw",
      mem(TEXT_UNIT_BYTES, { base: builder.read(base, 8), index: builder.read(out, 8), scale: TEXT_UNIT_BYTES }),
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
      .emit("movzwl", builder.write("rcx", 4), mem(TEXT_UNIT_BYTES, { base: builder.read(SOURCE, 8) }))
      .emit("testw", builder.read("rcx", 2), builder.read("rcx", 2))
      .to("je", "terminate")
      .emit("cmpl", builder.read("rcx", 4), imm(low))
      .to("jl", "store")
      .emit("cmpl", builder.read("rcx", 4), imm(high))
      .to("jg", "store")
      .emit(shift, builder.write("rcx", 4), imm(CASE_DISTANCE))
      .at("store")
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8) }), builder.read("rcx", 2))
      .emit("addq", builder.write("r9", 8), imm(TEXT_UNIT_BYTES))
      .emit("addq", builder.write(SOURCE, 8), imm(TEXT_UNIT_BYTES))
      .emit("decl", builder.write(CAPACITY, 4))
      .to("jmp", "step")
      .at("terminate")
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8) }), imm(0))
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
          "movzwl",
          builder.write("rdx", 4),
          mem(TEXT_UNIT_BYTES, { base: builder.read(SOURCE, 8), index: builder.read("r9", 8), scale: TEXT_UNIT_BYTES }),
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
          "movzwl",
          builder.write("rdx", 4),
          mem(TEXT_UNIT_BYTES, { base: builder.read(SOURCE, 8), index: builder.read("rdx", 8), scale: TEXT_UNIT_BYTES }),
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
      .emit(
        "leaq",
        builder.write(SOURCE, 8),
        mem(8, {
          base: builder.read(SOURCE, 8),
          index: builder.read("r9", 8),
          scale: TEXT_UNIT_BYTES,
        }),
      )
      .emit("movq", builder.write("r9", 8), builder.read(DESTINATION, 8))
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "done")
      .emit("decl", builder.write(CAPACITY, 4))
      .at("copy")
      .emit("testl", builder.read("rcx", 4), builder.read("rcx", 4))
      .to("jle", "terminate")
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "terminate")
      .emit("movzwl", builder.write("rdx", 4), mem(TEXT_UNIT_BYTES, { base: builder.read(SOURCE, 8) }))
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8) }), builder.read("rdx", 2))
      .emit("addq", builder.write("r9", 8), imm(TEXT_UNIT_BYTES))
      .emit("addq", builder.write(SOURCE, 8), imm(TEXT_UNIT_BYTES))
      .emit("decl", builder.write(CAPACITY, 4))
      .emit("decl", builder.write("rcx", 4))
      .to("jmp", "copy")
      .at("terminate")
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8) }), imm(0))
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
      .emit(
        "leaq",
        builder.write(SOURCE, 8),
        mem(8, {
          base: builder.read(SOURCE, 8),
          index: builder.read("r9", 8),
          scale: TEXT_UNIT_BYTES,
        }),
      )
      .emit("movq", builder.write("rdx", 8), builder.read(DESTINATION, 8))
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "done")
      .emit("decl", builder.write(CAPACITY, 4))
      .at("copy")
      .emit("testl", builder.read("rcx", 4), builder.read("rcx", 4))
      .to("jle", "terminate")
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "terminate")
      .emit("movzwl", builder.write("r8", 4), mem(TEXT_UNIT_BYTES, { base: builder.read(SOURCE, 8) }))
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }), builder.read("r8", 2))
      .emit("addq", builder.write("rdx", 8), imm(TEXT_UNIT_BYTES))
      .emit("addq", builder.write(SOURCE, 8), imm(TEXT_UNIT_BYTES))
      .emit("decl", builder.write(CAPACITY, 4))
      .emit("decl", builder.write("rcx", 4))
      .to("jmp", "copy")
      .at("terminate")
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }), imm(0))
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
      .emit("cmpw", mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }), imm(0))
      .to("je", "next")
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "overflow")
      .emit("movzwl", builder.write("rcx", 4), mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }))
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8) }), builder.read("rcx", 2))
      .emit("addq", builder.write("r9", 8), imm(TEXT_UNIT_BYTES))
      .emit("addq", builder.write("rdx", 8), imm(TEXT_UNIT_BYTES))
      .emit("decl", builder.write(CAPACITY, 4))
      .to("jmp", "inner")
      .at("next")
      .emit("decl", builder.write("r8", 4))
      .to("jmp", "round")
      .at("overflow");
    reportTextOverflow(builder, abi);
    builder
      .at("terminate")
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8) }), imm(0))
      .at("done");
    returnDestination(builder);
  };
}

function stringPad(abi: RuntimeAbi, leading: boolean): Emit {
  return (builder) => {
    loadArguments(abi, builder, [
      [DESTINATION, 8],
      [CAPACITY, 4],
      [SOURCE, 8],
      ["r9", 4],
      ["rcx", 8],
    ]);
    builder
      .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
      .to("jle", "done");
    measure(builder, SOURCE, "rdx", "pad_text");
    builder
      .emit("subl", builder.write("r9", 4), builder.read("rdx", 4))
      .emit("testl", builder.read("r9", 4), builder.read("r9", 4))
      .to("jg", "sized")
      .emit("xorl", builder.write("r9", 4), builder.read("r9", 4))
      .at("sized");
    measure(builder, "rcx", "r8", "pad_filler");
    builder
      .emit("testl", builder.read("r8", 4), builder.read("r8", 4))
      .to("jne", "fills")
      .emit("xorl", builder.write("r9", 4), builder.read("r9", 4))
      .at("fills")
      .emit("movl", builder.write("r8", 4), builder.read("r9", 4))
      .emit("addl", builder.write("r8", 4), builder.read("rdx", 4))
      .emit("cmpl", builder.read(CAPACITY, 4), builder.read("r8", 4))
      .to("jg", "fits");
    reportTextOverflow(builder, abi);
    builder.at("fits").emit("movq", builder.write("r8", 8), builder.read(DESTINATION, 8));
    if (leading) builder.emit(
        "leaq",
        builder.write("r8", 8),
        mem(8, {
          base: builder.read("r8", 8),
          index: builder.read("r9", 8),
          scale: TEXT_UNIT_BYTES,
        }),
      );
    builder
      .at("pad_copy")
      .emit("movzwl", builder.write("rdx", 4), mem(TEXT_UNIT_BYTES, { base: builder.read(SOURCE, 8) }))
      .emit("testw", builder.read("rdx", 2), builder.read("rdx", 2))
      .to("je", "pad_copied")
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r8", 8) }), builder.read("rdx", 2))
      .emit("addq", builder.write("r8", 8), imm(TEXT_UNIT_BYTES))
      .emit("addq", builder.write(SOURCE, 8), imm(TEXT_UNIT_BYTES))
      .to("jmp", "pad_copy")
      .at("pad_copied");
    if (leading) {
      builder
        .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r8", 8) }), imm(0))
        .emit("movq", builder.write("r8", 8), builder.read(DESTINATION, 8));
    }
    builder
      .emit("movq", builder.write("rdx", 8), builder.read("rcx", 8))
      .at("pad_fill")
      .emit("testl", builder.read("r9", 4), builder.read("r9", 4))
      .to("jle", "pad_filled")
      .emit("movzwl", builder.write(SOURCE, 4), mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }))
      .emit("testw", builder.read(SOURCE, 2), builder.read(SOURCE, 2))
      .to("jne", "pad_put")
      .emit("movq", builder.write("rdx", 8), builder.read("rcx", 8))
      .emit("movzwl", builder.write(SOURCE, 4), mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }))
      .at("pad_put")
      .emit(
        "movw",
        mem(TEXT_UNIT_BYTES, { base: builder.read("r8", 8) }),
        builder.read(SOURCE, 2),
      )
      .emit("addq", builder.write("r8", 8), imm(TEXT_UNIT_BYTES))
      .emit("addq", builder.write("rdx", 8), imm(TEXT_UNIT_BYTES))
      .emit("decl", builder.write("r9", 4))
      .to("jmp", "pad_fill")
      .at("pad_filled");
    if (!leading) builder.emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("r8", 8) }), imm(0));
    builder.at("done");
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
          "movzwl",
          builder.write("r12", 4),
          mem(TEXT_UNIT_BYTES, { base: builder.read("rcx", 8), index: builder.read("rbx", 8), scale: TEXT_UNIT_BYTES }),
        )
        .emit("testw", builder.read("r12", 2), builder.read("r12", 2))
        .to("je", next)
        .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
        .to("jle", "terminate")
        .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }), builder.read("r12", 2))
        .emit("addq", builder.write("rdx", 8), imm(TEXT_UNIT_BYTES))
        .emit("incq", builder.write("rbx", 8))
        .emit("decl", builder.write(CAPACITY, 4))
        .to("jmp", label);
    };

    const putSource = (next: string): void => {
      builder
        .emit("testl", builder.read(CAPACITY, 4), builder.read(CAPACITY, 4))
        .to("jle", "terminate")
        .emit("movzwl", builder.write("r12", 4), mem(TEXT_UNIT_BYTES, { base: builder.read("r8", 8) }))
        .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }), builder.read("r12", 2))
        .emit("addq", builder.write("rdx", 8), imm(TEXT_UNIT_BYTES))
        .emit("addq", builder.write("r8", 8), imm(TEXT_UNIT_BYTES))
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
      .emit("cmpw", mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8) }), imm(0))
      .to("je", "gaps")
      .at("scan")
      .emit("cmpw", mem(TEXT_UNIT_BYTES, { base: builder.read("r8", 8) }), imm(0))
      .to("je", "terminate")
      .emit("cmpw", mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8) }), imm(0))
      .to("je", "keep")
      .emit("xorl", builder.write("rbx", 4), builder.read("rbx", 4))
      .at("match")
      .emit(
        "movzwl",
        builder.write("r12", 4),
        mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8), index: builder.read("rbx", 8), scale: TEXT_UNIT_BYTES }),
      )
      .emit("testw", builder.read("r12", 2), builder.read("r12", 2))
      .to("je", "matched")
      .emit(
        "cmpw",
        mem(TEXT_UNIT_BYTES, { base: builder.read("r8", 8), index: builder.read("rbx", 8), scale: TEXT_UNIT_BYTES }),
        builder.read("r12", 2),
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
        "cmpw",
        mem(TEXT_UNIT_BYTES, { base: builder.read("r9", 8), index: builder.read("rbx", 8), scale: TEXT_UNIT_BYTES }),
        imm(0),
      )
      .to("je", "skipped")
      .emit("incq", builder.write("rbx", 8))
      .to("jmp", "skip")
      .at("skipped")
      .emit(
        "leaq",
        builder.write("r8", 8),
        mem(8, {
          base: builder.read("r8", 8),
          index: builder.read("rbx", 8),
          scale: TEXT_UNIT_BYTES,
        }),
      );
    if (!all) {
      builder.emit(
        "leaq",
        builder.write("r9", 8),
        mem(8, {
          base: builder.read("r9", 8),
          index: builder.read("rbx", 8),
          scale: TEXT_UNIT_BYTES,
        }),
      );
    }
    builder.to("jmp", "scan").at("keep");
    putSource("scan");

    builder.at("gaps");
    if (!all) putFresh("lead", "gapscan");
    builder
      .at("gapscan")
      .emit("cmpw", mem(TEXT_UNIT_BYTES, { base: builder.read("r8", 8) }), imm(0))
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
      .emit("movw", mem(TEXT_UNIT_BYTES, { base: builder.read("rdx", 8) }), imm(0))
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
        .emit(
        "leaq",
        builder.write("rcx", 8),
        mem(8, {
          base: builder.read("rcx", 8),
          index: builder.read("rdx", 8),
          scale: TEXT_UNIT_BYTES,
        }),
      );
    }
    builder
      .at("start")
      .emit("xorl", builder.write("rdx", 4), builder.read("rdx", 4))
      .at("compare")
      .emit("cmpl", builder.read("rdx", 4), builder.read("r9", 4))
      .to("jge", "found")
      .emit(
        "movzwl",
        builder.write("r8", 4),
        mem(TEXT_UNIT_BYTES, { base: builder.read("r10", 8), index: builder.read("rdx", 8), scale: TEXT_UNIT_BYTES }),
      )
      .emit(
        "cmpw",
        mem(TEXT_UNIT_BYTES, { base: builder.read("rcx", 8), index: builder.read("rdx", 8), scale: TEXT_UNIT_BYTES }),
        builder.read("r8", 2),
      )
      .to("jne", "advance")
      .emit("incl", builder.write("rdx", 4))
      .to("jmp", "compare")
      .at("advance");
    if (anchored) {
      builder.to("jmp", "missing");
    } else {
      builder
        .emit("cmpw", mem(TEXT_UNIT_BYTES, { base: builder.read("rcx", 8) }), imm(0))
        .to("je", "missing")
        .emit("addq", builder.write("rcx", 8), imm(TEXT_UNIT_BYTES))
        .to("jmp", "start");
    }
    builder.at("found");
    if (mode === "index") {
      builder
        .emit("subq", builder.write("rcx", 8), builder.read(SOURCE, 8))
        .emit("shrq", builder.write("rcx", 8), imm(TEXT_UNIT_SHIFT))
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
    [X64_RUNTIME_SYMBOLS.stringPadStart, stringPad(abi, true)],
    [X64_RUNTIME_SYMBOLS.stringPadEnd, stringPad(abi, false)],
    [X64_RUNTIME_SYMBOLS.stringReplace, stringReplace(abi, false)],
    [X64_RUNTIME_SYMBOLS.stringReplaceAll, stringReplace(abi, true)],
    [X64_RUNTIME_SYMBOLS.stringIndexOf, stringFind(abi, "index")],
    [X64_RUNTIME_SYMBOLS.stringIncludes, stringFind(abi, "includes")],
    [X64_RUNTIME_SYMBOLS.stringStartsWith, stringFind(abi, "prefix")],
    [X64_RUNTIME_SYMBOLS.stringEndsWith, stringFind(abi, "suffix")],
  ];
}
