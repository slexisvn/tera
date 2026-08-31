import { describe, expect, it } from "vitest";
import {
  def,
  imm,
  instruction,
  mem,
  use,
  MachineFunction,
  type MachineInstruction,
} from "../../../src/optimizing/machine/ir.js";
import { annotateCfi, CFI_END, CFI_START } from "../../../src/optimizing/machine/cfi-text.js";
import { x64CfiTarget, prologueEffectOf } from "../../../src/optimizing/backends/x64/unwind.js";
import { x64Target } from "../../../src/optimizing/backends/x64/target.js";

const registers = x64Target({ abi: "sysv", format: "elf" }).registers;

function physical(name: string) {
  return registers.register(name);
}

function prologue(node: MachineInstruction): MachineInstruction {
  (node.flags as { prologue?: boolean }).prologue = true;
  return node;
}

const allocate = (bytes: number) =>
  prologue(
    instruction("subq", [def(physical("rsp"), 8), use(physical("rsp"), 8), imm(bytes)], {
      tied: true,
    }),
  );

const save = (name: string, offset: number) =>
  prologue(
    instruction("movq", [
      mem(8, { base: use(physical("rsp"), 8), displacement: offset }),
      use(physical(name), 8),
    ]),
  );

function functionWith(instructions: readonly MachineInstruction[]): MachineFunction {
  const fn = new MachineFunction("probe", "probe");
  const block = fn.createBlock(".Lprobe_0");
  block.instructions.push(...instructions);
  return fn;
}

describe("annotateCfi", () => {
  it("describes each prologue instruction it can read", () => {
    const allocated = allocate(40);
    const saved = save("rbx", 0);
    const annotation = annotateCfi(functionWith([allocated, saved]), x64CfiTarget, prologueEffectOf);

    expect(annotation.describes).toBe(true);
    expect(annotation.after(allocated)).toEqual(["\t.cfi_def_cfa_offset 48"]);
    expect(annotation.after(saved)).toEqual(["\t.cfi_offset 3, -48"]);
  });

  it("says nothing about an instruction outside the prologue", () => {
    const allocated = allocate(16);
    const other = instruction("movl", [def(physical("rax"), 4), imm(1)]);
    const annotation = annotateCfi(
      functionWith([allocated, other]),
      x64CfiTarget,
      prologueEffectOf,
    );

    expect(annotation.after(other)).toEqual([]);
  });

  it("describes nothing when the function has no prologue", () => {
    const annotation = annotateCfi(
      functionWith([instruction("ret", [], { returns: true })]),
      x64CfiTarget,
      prologueEffectOf,
    );

    expect(annotation.describes).toBe(false);
    expect(CFI_START).toBe("\t.cfi_startproc");
    expect(CFI_END).toBe("\t.cfi_endproc");
  });

  it("describes nothing when one prologue instruction cannot be read", () => {
    const annotation = annotateCfi(
      functionWith([allocate(16), prologue(instruction("pushq", [use(physical("rbx"), 8)]))]),
      x64CfiTarget,
      prologueEffectOf,
    );

    expect(annotation.describes).toBe(false);
  });
});

describe("prologueEffectOf", () => {
  const saved = (opcode: string, name: string, offset: number) =>
    instruction(opcode, [
      mem(8, { base: use(physical("rsp"), 8), displacement: offset }),
      use(physical(name), 8),
    ]);

  it("reads a callee-saved integer register out of a movq", () => {
    expect(prologueEffectOf(saved("movq", "rbx", 8))).toEqual({
      kind: "save",
      register: "rbx",
      offset: 8,
    });
  });

  it("reads a vector register out of the movups that spills it", () => {
    expect(prologueEffectOf(saved("movups", "xmm6", 16))).toEqual({
      kind: "save",
      register: "xmm6",
      offset: 16,
    });
  });

  it("names no effect for a vector spill that is not made through the stack pointer", () => {
    const throughFrame = instruction("movups", [
      mem(8, { base: use(physical("rbp"), 8), displacement: 16 }),
      use(physical("xmm6"), 8),
    ]);

    expect(prologueEffectOf(throughFrame)).toBeNull();
  });

  it("names no effect for a store the prologue does not make", () => {
    expect(prologueEffectOf(saved("movaps", "xmm6", 16))).toBeNull();
  });

  it("names no effect for a spill that is not slot aligned", () => {
    expect(prologueEffectOf(saved("movups", "xmm6", 4))).toBeNull();
  });
});
