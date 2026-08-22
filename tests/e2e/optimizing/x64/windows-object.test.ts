import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { inspectPe, itDumpsObjects } from "../../../helpers/gnu-assembler.js";

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend: "x64-windows",
    format: "object",
  });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  return program;
}

function objectOf(source: string): Uint8Array {
  const file = compile(source).files.find((candidate) => candidate.name.endsWith(".obj"));
  if (file === undefined) throw new Error("program has no object output");
  return file.contents as Uint8Array;
}

const ARITHMETIC = src("fn twice(n: int) -> int:", "  return n + n");
const DIVIDING = src("fn half(n: int) -> int:", "  return Math.floor(n / 2)");
const FLOATING = src("fn scaled(x: float) -> float:", "  return x * 1.5");
const ROUNDED = src("fn down(x: float) -> float:", "  return Math.floor(x)");

describe("x64 coff object emission", () => {
  itDumpsObjects("emits a relocatable object next to the header", () => {
    const program = compile(ARITHMETIC);

    expect(program.files.map((file) => file.name)).toEqual(["program.h", "program.obj"]);
  });

  itDumpsObjects("produces a header binutils reads as a 64 bit coff object", () => {
    const report = inspectPe(objectOf(ARITHMETIC), ["-f"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain("pe-x86-64");
    expect(report.output).toContain("HAS_RELOC");
  });

  itDumpsObjects("publishes the compiled function as an external symbol", () => {
    const report = inspectPe(objectOf(ARITHMETIC), ["-t"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/\(ty\s+20\)\(scl\s+2\).*\btwice\b/);
  });

  itDumpsObjects("keeps a pulled in runtime routine static in the object", () => {
    const report = inspectPe(objectOf(DIVIDING), ["-t"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/\(ty\s+20\)\(scl\s+3\).*\btera_x64_to_i32\b/);
  });

  itDumpsObjects("puts float constants in a read only data section", () => {
    const report = inspectPe(objectOf(FLOATING), ["-h"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/\.rodata[\s\S]*READONLY, DATA/);
  });

  itDumpsObjects("rounds without leaving any undefined symbol behind", () => {
    const report = inspectPe(objectOf(ROUNDED), ["-t", "-r"]);

    expect(report.failed).toBe(false);
    expect(report.output).not.toContain("IMAGE_REL");
    expect(report.output).not.toMatch(/\(sec\s+0\)/);
  });

  itDumpsObjects("relocates a reference into the data section", () => {
    const report = inspectPe(objectOf(FLOATING), ["-r"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/IMAGE_REL_AMD64_REL32\s+\.LC0\w*/);
  });

  itDumpsObjects("relocates a call to another compiled function", () => {
    const source = src(
      "fn triple(n: int) -> int:",
      "  if n < 0:",
      "    return 0",
      "  return n * 3",
      "fn main() -> int:",
      "  return triple(4)",
    );
    const report = inspectPe(objectOf(source), ["-r"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/IMAGE_REL_AMD64_REL32\s+triple/);
  });

  itDumpsObjects("asks the linker for the alignment each section was built with", () => {
    const report = inspectPe(objectOf(FLOATING), ["-h"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/\.text[\s\S]*?2\*\*4/);
    expect(report.output).toMatch(/\.rodata[\s\S]*?2\*\*3/);
  });
});
