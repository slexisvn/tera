import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend: "riscv64",
  });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  return program;
}

function assemblyOf(source: string): string {
  const file = compile(source).files.find((candidate) => candidate.name.endsWith(".s"));
  if (file === undefined) throw new Error("program has no assembly output");
  return String(file.contents);
}

function headerOf(source: string): string {
  const file = compile(source).files.find((candidate) => candidate.name.endsWith(".h"));
  if (file === undefined) throw new Error("program has no header output");
  return String(file.contents);
}

describe("riscv64 assembly", () => {
  it("takes integer arguments in a0 and returns in a0", () => {
    const assembly = assemblyOf(src("fn twice(n: int) -> int:", "  return n + n"));

    expect(assembly).toContain("\t.globl twice");
    expect(assembly).toMatch(/mv\s+\w+, a0/);
    expect(assembly).toMatch(/mv\s+a0, \w+/);
    expect(assembly).toContain("\tret");
  });

  it("takes float arguments in fa0 and returns in fa0", () => {
    const assembly = assemblyOf(src("fn half(x: float) -> float:", "  return x * 0.5"));

    expect(assembly).toMatch(/fmv\.d\s+\w+, fa0/);
    expect(assembly).toContain("fmul.d");
    expect(assembly).toMatch(/fmv\.d\s+fa0, \w+/);
  });

  it("fuses a comparison into a conditional branch", () => {
    const assembly = assemblyOf(
      src("fn pick(a: int, b: int) -> int:", "  if a < b:", "    return a", "  return b"),
    );

    expect(assembly).toMatch(/blt\s+\w+, \w+, \.L/);
    expect(assembly).not.toContain("slt ");
  });

  it("computes element addresses explicitly because there is no scaled index mode", () => {
    const assembly = assemblyOf(
      src("fn at(i: int) -> float:", "  data = [1.5, 2.5]", "  return data[i]"),
    );

    expect(assembly).toMatch(/slli\s+\w+, \w+, 3/);
    expect(assembly).toMatch(/add\s+\w+, \w+, \w+/);
    expect(assembly).toMatch(/fld\s+\w+, \d+\(\w+\)/);
  });

  it("saves and restores the return address around a call", () => {
    const assembly = assemblyOf(
      src(
        "fn leaf(x: float) -> float:",
        "  if x < 0.0:",
        "    return 0.0",
        "  return x + 1.0",
        "fn caller(x: float) -> float:",
        "  return leaf(x) * 2.0",
      ),
    );

    expect(assembly).toMatch(/sd\s+ra, \d+\(sp\)/);
    expect(assembly).toMatch(/ld\s+ra, \d+\(sp\)/);
    expect(assembly).toContain("\tcall leaf");
  });

  it("does not reserve a frame for a leaf function that needs no stack", () => {
    const assembly = assemblyOf(src("fn one() -> int:", "  return 1"));

    expect(assembly).not.toContain("addi sp, sp");
  });

  it("uses the three address forms rather than destructive copies", () => {
    const assembly = assemblyOf(src("fn diff(a: int, b: int) -> int:", "  return a - b"));
    const subtract = assembly.match(/subw\s+(\w+), (\w+), (\w+)/);

    expect(subtract).not.toBeNull();
    expect(subtract![1]).not.toBe(subtract![3]);
  });

  it("emits IEEE aware float comparisons without a parity fixup", () => {
    const assembly = assemblyOf(
      src("fn same(a: float, b: float) -> bool:", "  r = a == b", "  return r"),
    );

    expect(assembly).toContain("feq.d");
    expect(assembly).not.toContain("xori");
  });

  it("emits doubles into read only data and loads them pc relative", () => {
    const assembly = assemblyOf(src("fn pi() -> float:", "  return 3.5"));

    expect(assembly).toContain("\t.section .rodata");
    expect(assembly).toMatch(/\.quad 0x400c000000000000/);
    expect(assembly).toMatch(/lla\s+\w+, \.LC0\w*/);
  });

  it("emits a C header the same shape as the other AOT backends", () => {
    const header = headerOf(src("fn add(a: int, b: float) -> float:", "  return a + b"));

    expect(header).toContain("#include <stdint.h>");
    expect(header).toContain("double add(int32_t p0, double p1);");
  });

  it("emits the runtime routine only when a function references it", () => {
    const withHelper = assemblyOf(src("fn rem(a: int, b: int) -> int:", "  return (a % b) + 0"));
    const withoutHelper = assemblyOf(src("fn sum(a: int, b: int) -> int:", "  return a + b"));

    expect(withHelper).toContain("tera_rv64_i32_mod:");
    expect(withoutHelper).not.toContain("tera_rv64_i32_mod:");
  });

  it("writes a line through the print routine", () => {
    const assembly = assemblyOf('print("hi")');

    expect(assembly).toContain("tera_rv64_print_str:");
    expect(assembly).toContain("\tecall");
    expect(assembly).toContain("\tli a7, 64");
  });

  it("formats an integer before writing it", () => {
    const assembly = assemblyOf("print(7)");

    expect(assembly).toContain("tera_rv64_print_i32:");
    expect(assembly).toContain("tera_rv64_i32_to_str:");
  });

  it("reads one line at a time through the input routine", () => {
    const assembly = assemblyOf('print(input("> "))');

    expect(assembly).toContain("tera_rv64_input:");
    expect(assembly).toContain("\tli a7, 63");
    expect(assembly).toContain("\tli a2, 1");
  });

  it("emits the data a runtime routine of its own needs", () => {
    const assembly = assemblyOf("print(7)");

    expect(assembly).toMatch(/lla\s+a0, \.LR\w*/);
    expect(assembly).toContain("\t.data");
  });

  it("refuses an object because it has no working encoder yet", () => {
    const build = () =>
      nodeEngine({ typecheck: "off" }).compileAot(
        src("fn twice(n: int) -> int:", "  return n + n"),
        { backend: "riscv64", format: "object" },
      );

    expect(build).toThrow(/riscv64 backend cannot emit: this target has no machine code encoder/);
  });
});
