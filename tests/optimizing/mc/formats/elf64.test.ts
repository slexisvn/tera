import { describe, expect, it } from "vitest";
import {
  MachineFunction,
  imm,
  instruction,
  use,
  def,
  sym,
} from "../../../../src/optimizing/machine/ir.js";
import { assembleFunction } from "../../../../src/optimizing/mc/assembler.js";
import { layoutModule } from "../../../../src/optimizing/mc/layout.js";
import { McModule } from "../../../../src/optimizing/mc/module.js";
import {
  ELF_MACHINE_X86_64,
  layoutElf64Executable,
  writeElf64Executable,
  writeElf64Object,
} from "../../../../src/optimizing/mc/formats/elf64.js";
import { x64McTarget } from "../../../../src/optimizing/backends/x64/mc/target.js";
import { x64Target } from "../../../../src/optimizing/backends/x64/target.js";
import { inspectElf, itReadsElf } from "../../../helpers/gnu-assembler.js";

const target = x64Target({ abi: "sysv", format: "elf" });
const reg = (name: string) => target.registers.register(name);

function answering(name: string, value: number): MachineFunction {
  const fn = new MachineFunction(name, name);
  const entry = fn.createBlock(`.L${name}_entry`);
  entry.instructions.push(instruction("movl", [def(reg("rax"), 4), imm(value)]));
  entry.instructions.push(
    instruction("ret", [use(reg("rax"), 4)], { returns: true, implicitFrom: 0 }),
  );
  return fn;
}

function calling(name: string, callee: string): MachineFunction {
  const fn = new MachineFunction(name, name);
  const entry = fn.createBlock(`.L${name}_entry`);
  entry.instructions.push(
    instruction("call", [sym(callee)], { call: true, implicitFrom: 1 }),
  );
  entry.instructions.push(
    instruction("ret", [use(reg("rax"), 4)], { returns: true, implicitFrom: 0 }),
  );
  return fn;
}

function objectImage(): Uint8Array {
  const module = new McModule();
  assembleFunction(module, x64McTarget, answering("answer", 42));
  assembleFunction(module, x64McTarget, calling("ask", "external_answer"));
  layoutModule(module, x64McTarget);
  return writeElf64Object(module, x64McTarget, { machine: ELF_MACHINE_X86_64 });
}

function executableImage(): Uint8Array {
  const module = new McModule();
  assembleFunction(module, x64McTarget, answering("_start", 0));
  layoutElf64Executable(module, x64McTarget, {
    machine: ELF_MACHINE_X86_64,
    entrySymbol: "_start",
  });
  return writeElf64Executable(module, {
    machine: ELF_MACHINE_X86_64,
    entrySymbol: "_start",
  });
}

describe("elf64 container", () => {
  it("starts with the elf identification for a 64 bit little endian file", () => {
    const image = objectImage();

    expect([...image.subarray(0, 7)]).toEqual([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  });

  it("marks an object as relocatable and an image as executable", () => {
    expect(objectImage()[16]).toBe(1);
    expect(executableImage()[16]).toBe(2);
  });

  it("refuses to write an executable that still has unresolved symbols", () => {
    const module = new McModule();
    assembleFunction(module, x64McTarget, calling("_start", "external_answer"));
    layoutElf64Executable(module, x64McTarget, {
      machine: ELF_MACHINE_X86_64,
      entrySymbol: "_start",
    });

    expect(() =>
      writeElf64Executable(module, {
        machine: ELF_MACHINE_X86_64,
        entrySymbol: "_start",
      }),
    ).toThrow(/unresolved symbols: external_answer/);
  });

  it("places loadable segments so the file offset matches the virtual address page", () => {
    const module = new McModule();
    assembleFunction(module, x64McTarget, answering("_start", 0));
    layoutElf64Executable(module, x64McTarget, {
      machine: ELF_MACHINE_X86_64,
      entrySymbol: "_start",
      baseAddress: 0x400000,
      pageSize: 0x1000,
    });

    expect(module.symbols.addressOf("_start")! % 0x1000).toBe(0);
    expect(module.symbols.addressOf("_start")).toBe(0x401000);
  });
});

describe("elf64 container read back by binutils", () => {
  itReadsElf("produces an object header binutils accepts", () => {
    const report = inspectElf(objectImage(), ["-h"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain("Advanced Micro Devices X86-64");
    expect(report.output).toContain("REL (Relocatable file)");
  });

  itReadsElf("names every section it writes", () => {
    const report = inspectElf(objectImage(), ["-S"]);

    expect(report.failed).toBe(false);
    for (const name of [".text", ".symtab", ".strtab", ".shstrtab", ".rela.text"]) {
      expect(report.output).toContain(name);
    }
  });

  itReadsElf("publishes defined functions as global symbols", () => {
    const report = inspectElf(objectImage(), ["-s"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/GLOBAL\s+DEFAULT\s+\d+\s+answer/);
    expect(report.output).toMatch(/GLOBAL\s+DEFAULT\s+\d+\s+ask/);
  });

  itReadsElf("records the call to an undefined symbol as a plt relocation", () => {
    const report = inspectElf(objectImage(), ["-r"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain("R_X86_64_PLT32");
    expect(report.output).toContain("external_answer - 4");
  });

  itReadsElf("describes an executable with one loadable executable segment", () => {
    const report = inspectElf(executableImage(), ["-h", "-l"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain("EXEC (Executable file)");
    expect(report.output).toMatch(/LOAD\s+0x0*1000\s+0x0*401000/);
    expect(report.output).toMatch(/R E/);
  });

  itReadsElf("disassembles back to the instructions it was given", () => {
    const report = inspectElf(objectImage(), ["-x", ".text"]);

    expect(report.failed).toBe(false);
    expect(report.output.replace(/\s+/g, "")).toContain("b82a000000");
  });
});
