import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import {
  assembleText,
  extractSection,
  hex,
  inspectElf,
  itAssembles,
  itReadsElf,
  linkAndRun,
} from "../../../helpers/gnu-assembler.js";
import { hostBackendId } from "../../../../src/optimizing/backends/index.js";

const src = (...lines: string[]) => lines.join("\n");

const ELF_BACKEND = "x64-linux";
const HOST_BACKEND = hostBackendId()!;

function compile(
  source: string,
  format: "assembly" | "object",
  backend: string,
): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, { backend, format });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  return program;
}

function fileOf(program: AotProgram, extension: string): string | Uint8Array {
  const file = program.files.find((candidate) => candidate.name.endsWith(extension));
  if (file === undefined) throw new Error(`program has no ${extension} output`);
  return file.contents;
}

function objectOf(source: string): Uint8Array {
  return fileOf(compile(source, "object", ELF_BACKEND), ".o") as Uint8Array;
}

interface HostObject {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly headers: ReadonlyMap<string, string>;
}

function hostObject(source: string): HostObject {
  const headers = new Map<string, string>();
  let object: { name: string; bytes: Uint8Array } | undefined;
  for (const file of compile(source, "object", HOST_BACKEND).files) {
    if (typeof file.contents === "string") headers.set(file.name, file.contents);
    else object = { name: file.name, bytes: file.contents };
  }
  if (object === undefined) throw new Error("program has no object output");
  return { ...object, headers };
}

function assemblyOf(source: string): string {
  return String(fileOf(compile(source, "assembly", HOST_BACKEND), ".s"));
}

const ARITHMETIC = src("fn twice(n: int) -> int:", "  return n + n");
const DIVIDING = src("fn half(n: int) -> int:", "  return Math.floor(n / 2)");
const FLOATING = src("fn scaled(x: float) -> float:", "  return x * 1.5");
const ROUNDED = src("fn down(x: float) -> float:", "  return Math.floor(x)");

describe("x64 elf object emission", () => {
  itReadsElf("emits a relocatable object next to the header", () => {
    const program = compile(ARITHMETIC, "object", ELF_BACKEND);

    expect(program.files.map((file) => file.name)).toEqual(["program.h", "program.o"]);
    expect(fileOf(program, ".o")).toBeInstanceOf(Uint8Array);
  });

  itReadsElf("publishes the compiled function as a global symbol", () => {
    const report = inspectElf(objectOf(ARITHMETIC), ["-s"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/FUNC\s+GLOBAL\s+DEFAULT\s+\d+\s+twice/);
  });

  itReadsElf("keeps a pulled in runtime routine local to the object", () => {
    const report = inspectElf(objectOf(DIVIDING), ["-s"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/FUNC\s+LOCAL\s+DEFAULT\s+\d+\s+tera_x64_to_i32/);
  });

  itReadsElf("puts float constants in a read only data section", () => {
    const report = inspectElf(objectOf(FLOATING), ["-S"]);

    expect(report.failed).toBe(false);
    expect(report.output).toContain(".rodata");
  });

  itReadsElf("rounds without leaving any undefined symbol behind", () => {
    const report = inspectElf(objectOf(ROUNDED), ["-s", "-r"]);

    expect(report.failed).toBe(false);
    expect(report.output).not.toContain("Relocation section '.rela.text'");
    expect(report.output).not.toMatch(/UND +\S/);
  });

  itReadsElf("relocates a reference into the data section", () => {
    const report = inspectElf(objectOf(FLOATING), ["-r"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/R_X86_64_PC32\s+\S+\s+\.LC0\w* - 4/);
  });

  itReadsElf("relocates a call to another compiled function", () => {
    const source = src(
      "fn triple(n: int) -> int:",
      "  if n < 0:",
      "    return 0",
      "  return n * 3",
      "fn main() -> int:",
      "  return triple(4)",
    );
    const report = inspectElf(objectOf(source), ["-r"]);

    expect(report.failed).toBe(false);
    expect(report.output).toMatch(/R_X86_64_PLT32\s+\S+\s+triple - 4/);
  });
});

describe("x64 object against the same program assembled by gas", () => {
  for (const [name, source] of [
    ["integer arithmetic", ARITHMETIC],
    ["a runtime helper call", DIVIDING],
    ["a float constant", FLOATING],
  ] as const) {
    itAssembles(`encodes ${name} to the same text bytes`, () => {
      const mine = extractSection(hostObject(source).bytes, ".text");
      const theirs = assembleText(assemblyOf(source));

      expect(hex(mine)).toBe(hex(theirs.subarray(0, mine.length)));
    });
  }
});

describe("x64 object handed to the host toolchain", () => {
  const CALLER = [
    "#include <stdio.h>",
    '#include "program.h"',
    "int main(void) {",
    '  printf("%.2f %d\\n", scaled(3.0), half(84));',
    "  return 0;",
    "}",
    "",
  ].join("\n");

  itAssembles("links into a program that computes what the functions promise", () => {
    const object = hostObject(src(FLOATING, DIVIDING));

    const run = linkAndRun(object.bytes, object.name, CALLER, object.headers);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("4.50 42");
  });
});
