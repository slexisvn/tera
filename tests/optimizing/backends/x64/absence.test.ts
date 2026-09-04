import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { hostBackendId } from "../../../../src/optimizing/backends/host.js";
import {
  ABSENCE_VALUES,
  absenceValueOf,
} from "../../../../src/optimizing/metadata/printed-values.js";
import { FLOAT64_EXPONENT_MASK } from "../../../../src/optimizing/target/float64.js";
import { dataItemText, integerData } from "../../../../src/optimizing/machine/data.js";

const HOST_TARGET = hostBackendId()!;
const FLOAT_TEXT_ROUTINE = "tera_x64_f64_to_str";
const UNDEFINED_ABSENCE = absenceValueOf(undefined)!;
const DOUBLE_BYTES = 8;

const src = (...lines: string[]) => lines.join("\n");

const ABSENT_INT = src(
  "fn f(n: int | null) -> int:",
  "  if n == null:",
  "    return 0",
  "  return 1",
  "print(f(null))",
);

const ABSENT_FLOAT_CONSTANT = src(
  "fn at(n: int) -> int | undefined:",
  "  if n > 0:",
  "    return n",
  "  return undefined",
  "print(at(0))",
);

const ABSENT_REFERENCE_CONSTANT = src(
  "fn name(n: int) -> string | undefined:",
  "  if n > 0:",
  '    return "a"',
  "  return undefined",
  "print(name(0))",
);

const PRINTS_ABSENT_NUMBER = src("xs: int[] = []", "print(xs.pop())");

function assemblyOf(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend: HOST_TARGET,
  });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  const file = program.files.find((candidate) => candidate.name.endsWith(".s"));
  if (file === undefined) throw new Error("program has no assembly output");
  return String(file.contents);
}

function linesOf(assembly: string): string[] {
  return assembly.split(/\r?\n/);
}

function bodyOf(assembly: string, symbol: string): string {
  const lines = linesOf(assembly);
  const opened = lines.indexOf(`${symbol}:`);
  if (opened < 0) throw new Error(`assembly has no ${symbol}`);
  const closed = lines.indexOf("\t.cfi_endproc", opened);
  return lines.slice(opened, closed < 0 ? lines.length : closed).join("\n");
}

function routineOf(assembly: string, symbol: string): string {
  const lines = linesOf(assembly);
  const opened = lines.indexOf(`${symbol}:`);
  if (opened < 0) throw new Error(`assembly has no ${symbol}`);
  const after = lines.slice(opened + 1).findIndex((line) => /^\t\.(text|globl)/.test(line));
  return lines.slice(opened, after < 0 ? lines.length : opened + 1 + after).join("\n");
}

function constantsOf(assembly: string, symbol: string): string[] {
  const lines = linesOf(assembly);
  const label = new RegExp(`^\\.LC\\d+_${symbol}:$`);
  return lines
    .filter((_, at) => label.test(lines[at - 1] ?? ""))
    .map((line) => line.trim())
    .sort();
}

function countOf(text: string, mnemonic: string): number {
  return linesOf(text).filter((line) => line.trim().startsWith(`${mnemonic} `)).length;
}

function quadFor(bits: bigint): string {
  return dataItemText(integerData(bits, DOUBLE_BYTES)).trim();
}

function textCopiedFor(assembly: string, bits: bigint): string | null {
  const lines = linesOf(assembly);
  const tested = lines.findIndex((line) => line.includes(`movabsq $${bits},`));
  if (tested < 0) return null;
  const loaded = lines.slice(tested).find((line) => /leaq \.LR\d+_/.test(line));
  const label = loaded?.match(/\.LR\d+_\w+/)?.[0];
  const declared = lines.indexOf(`${label}:`);
  return declared < 0 ? null : (lines[declared + 1] ?? "").trim();
}

describe("x64 lowers a loose comparison against absence", () => {
  it("tests each operand against every absence payload the language has", () => {
    const assembly = assemblyOf(ABSENT_INT);

    expect(countOf(bodyOf(assembly, "f"), "cmpq")).toBe(2 * ABSENCE_VALUES.length);
    expect(constantsOf(assembly, "f")).toEqual(
      ABSENCE_VALUES.map((absence) => quadFor(absence.bits)).sort(),
    );
  });

  it("reduces each operand's tests down to a single flag", () => {
    const body = bodyOf(assemblyOf(ABSENT_INT), "f");

    expect(countOf(body, "sete")).toBe(2 * ABSENCE_VALUES.length + 1);
    expect(countOf(body, "orl")).toBe(2 * (ABSENCE_VALUES.length - 1));
  });

  it("answers the comparison from the two flags rather than from the payloads", () => {
    const body = bodyOf(assemblyOf(ABSENT_INT), "f");

    expect(body).toMatch(/\tcmpl %e\w+, %e\w+\n\tsete %\w+\n/);
  });
});

describe("x64 materialises an absence constant", () => {
  it("gives an undefined float constant the payload undefined owns", () => {
    expect(constantsOf(assemblyOf(ABSENT_FLOAT_CONSTANT), "at")).toEqual([
      quadFor(UNDEFINED_ABSENCE.bits),
    ]);
  });

  it("gives an absent reference the null pointer instead of a number", () => {
    const body = bodyOf(assemblyOf(ABSENT_REFERENCE_CONSTANT), "name");

    expect(body).toMatch(/\tmovabsq \$0, %r\w+\n/);
    expect(body).not.toMatch(/\$NaN/);
  });
});

describe("x64 prints an absent number", () => {
  it("copies a text of its own for every absence payload", () => {
    const assembly = assemblyOf(PRINTS_ABSENT_NUMBER);

    for (const absence of ABSENCE_VALUES) {
      expect(textCopiedFor(assembly, absence.bits)).toBe(`.asciz "${absence.text}"`);
    }
  });

  it("tests every absence payload before it decodes the exponent", () => {
    const routine = routineOf(assemblyOf(PRINTS_ABSENT_NUMBER), FLOAT_TEXT_ROUTINE);
    const decodedAt = routine.indexOf(`andl $${FLOAT64_EXPONENT_MASK},`);

    expect(decodedAt).toBeGreaterThan(0);
    for (const absence of ABSENCE_VALUES) {
      const testedAt = routine.indexOf(`movabsq $${absence.bits},`);

      expect(testedAt).toBeGreaterThan(0);
      expect(testedAt).toBeLessThan(decodedAt);
    }
  });
});
