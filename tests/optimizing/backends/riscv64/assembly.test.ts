import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { ABSENCE_VALUES } from "../../../../src/optimizing/metadata/printed-values.js";
import { FLOAT64_EXPONENT_MASK } from "../../../../src/optimizing/target/float64.js";
import {
  C_CHAR,
  C_NARROW_TEXT_UNIT,
  C_WIDE_TEXT_UNIT,
} from "../../../../src/optimizing/target/c-types.js";
import { riscvTarget } from "../../../../src/optimizing/backends/riscv64/target.js";

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
    expect(assembly).toMatch(/^\t\w[\w.]*\s+a0,/m);
    expect(assembly).toContain("\tret");
  });

  it("takes float arguments in fa0 and returns in fa0", () => {
    const assembly = assemblyOf(src("fn half(x: float) -> float:", "  return x * 0.5"));

    expect(assembly).toMatch(/fmv\.d\s+\w+, fa0/);
    expect(assembly).toMatch(/^\tfmul\.d\s+fa0,/m);
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
        "fn leaf(x: float, n: int) -> float:",
        "  if n <= 0:",
        "    return x",
        "  return leaf(x, n - 1) + 1.0",
        "fn caller(x: float) -> float:",
        "  return leaf(x, 3) * 2.0",
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

  it("names the character type after the byte it stores a character in", () => {
    const header = headerOf(src("fn add(a: int, b: float) -> float:", "  return a + b"));

    expect(riscvTarget().capabilities.has("utf16-text")).toBe(false);
    expect(header).toContain(`typedef ${C_NARROW_TEXT_UNIT} ${C_CHAR};`);
    expect(header).not.toContain(C_WIDE_TEXT_UNIT);
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

  it("describes its prologue with call frame directives", () => {
    const assembly = assemblyOf(
      src(
        "fn fib(n: int) -> int:",
        "  if n < 2:",
        "    return n",
        "  return fib(n - 1) + fib(n - 2)",
        "print(fib(10))",
      ),
    );

    expect(assembly).toContain("	.cfi_startproc");
    expect(assembly).toMatch(/addi sp, sp, -(\d+)\n\t[.]cfi_def_cfa_offset \1/);
    expect(assembly).toMatch(/sd ra, \d+[(]sp[)]\n\t[.]cfi_offset 1, -\d+/);
    expect(assembly).toContain("	.cfi_endproc");
  });

  it("balances every opened frame description", () => {
    const assembly = assemblyOf(src("fn twice(n: int) -> int:", "  return n + n", "print(twice(2))"));

    expect(assembly.split("	.cfi_startproc").length).toBe(
      assembly.split("	.cfi_endproc").length,
    );
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

const FLOAT_TEXT_ROUTINE = "tera_rv64_f64_to_str";

function linesOf(assembly: string): string[] {
  return assembly.split(/\r?\n/);
}

function routineOf(assembly: string, symbol: string): string {
  const lines = linesOf(assembly);
  const opened = lines.indexOf(`${symbol}:`);
  if (opened < 0) throw new Error(`assembly has no ${symbol}`);
  const closed = lines.findIndex((line) => line.startsWith(`\t.size ${symbol},`));
  return lines.slice(opened, closed < 0 ? lines.length : closed).join("\n");
}

function textCopiedFor(assembly: string, bits: bigint): string | null {
  const lines = linesOf(assembly);
  const held = new RegExp(`^li \\w+, ${bits}$`);
  const tested = lines.findIndex((line) => held.test(line.trim()));
  if (tested < 0) return null;
  const loaded = lines.slice(tested).find((line) => /lla \w+, \.LR\d+_/.test(line));
  const label = loaded?.match(/\.LR\d+_\w+/)?.[0];
  const declared = lines.indexOf(`${label}:`);
  return declared < 0 ? null : (lines[declared + 1] ?? "").trim();
}

describe("riscv64 absent numbers", () => {
  const PRINTS_ABSENCE = src("xs: int[] = []", "print(xs.pop())");

  it("copies a text of its own for every absent payload it can be handed", () => {
    const assembly = assemblyOf(PRINTS_ABSENCE);

    for (const absence of ABSENCE_VALUES) {
      expect(textCopiedFor(assembly, absence.bits)).toBe(`.asciz "${absence.text}"`);
    }
  });

  it("tests every absent payload before it decodes the exponent", () => {
    const routine = routineOf(assemblyOf(PRINTS_ABSENCE), FLOAT_TEXT_ROUTINE);
    const decodedAt = routine.search(
      new RegExp(`andi \\w+, \\w+, ${FLOAT64_EXPONENT_MASK}\\b`),
    );

    expect(decodedAt).toBeGreaterThan(0);
    for (const absence of ABSENCE_VALUES) {
      const testedAt = routine.search(new RegExp(`li \\w+, ${absence.bits}\\b`));

      expect(testedAt).toBeGreaterThan(0);
      expect(testedAt).toBeLessThan(decodedAt);
    }
  });
});
