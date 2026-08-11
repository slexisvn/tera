import { describe, expect } from "vitest";
import { Engine } from "../../../../src/api/engine.js";
import { AOT_STRING_BUFFER_CAPACITY } from "../../../../src/optimizing/analyses/aot-legality.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import {
  itAssembles,
  runNativeStringBatch,
  type NativeArgument,
} from "../../../helpers/native-executor.js";
import { cSource, runCStringFunction, type CArgument } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

const FUNCTIONS: readonly string[] = [
  src("fn cat(a: string, b: string) -> string:", "  return a + b"),
  src("fn catLiteral(a: string) -> string:", '  return a + " balanced"'),
  src("fn render(n: int) -> string:", "  return n.to_string()"),
  src("fn charAt(s: string, i: int) -> string:", "  return s.char_at(i)"),
  src("fn mixed(n: int, s: string) -> string:", "  return n.to_string() + s"),
  src(
    "fn repeat(n: int) -> string:",
    '  out = ""',
    "  i = 0",
    "  while i < n:",
    '    out = out + "ab"',
    "    i = i + 1",
    "  return out",
  ),
  src(
    "fn coefficients(n: int) -> string:",
    '  out = ""',
    "  i = 1",
    "  while i <= n:",
    '    out = out + i.to_string() + "H2O "',
    "    i = i + 1",
    "  return out",
  ),
  src(
    "fn rebuild(s: string, n: int) -> string:",
    '  out = ""',
    "  i = 0",
    "  while i < n:",
    "    out = out + s.char_at(i)",
    "    i = i + 1",
    "  return out",
  ),
  src(
    "fn branched(n: int) -> string:",
    "  if n > 1:",
    '    return n.to_string() + "x"',
    '  return "x"',
  ),
  src(
    "fn overflow(n: int) -> string:",
    '  out = ""',
    "  i = 0",
    "  while i < n:",
    '    out = out + "abcdefghij"',
    "    i = i + 1",
    "  return out",
  ),
];

const SOURCE = FUNCTIONS.join("\n");

type Case = { readonly symbol: string; readonly args: readonly NativeArgument[]; readonly call: string };

const CASES: readonly Case[] = [
  { symbol: "cat", args: ["Fe2", "O3"], call: 'cat("Fe2", "O3")' },
  { symbol: "catLiteral", args: ["H2O"], call: 'catLiteral("H2O")' },
  { symbol: "render", args: [1234567], call: "render(1234567)" },
  { symbol: "render", args: [0], call: "render(0)" },
  { symbol: "render", args: [-2147483648], call: "render(-2147483648)" },
  { symbol: "charAt", args: ["H2O", 2], call: 'charAt("H2O", 2)' },
  { symbol: "charAt", args: ["H2O", 9], call: 'charAt("H2O", 9)' },
  { symbol: "mixed", args: [12, "H2O"], call: 'mixed(12, "H2O")' },
  { symbol: "repeat", args: [4], call: "repeat(4)" },
  { symbol: "coefficients", args: [3], call: "coefficients(3)" },
  { symbol: "rebuild", args: ["NaHCO3", 6], call: 'rebuild("NaHCO3", 6)' },
  { symbol: "branched", args: [3], call: "branched(3)" },
  { symbol: "branched", args: [1], call: "branched(1)" },
];

const engine = new Engine({ typecheck: "off" });
const compiled = new Map<string, AotProgram>();

function compile(backend: "x64" | "c"): AotProgram {
  const cached = compiled.get(backend);
  if (cached !== undefined) return cached;
  const program =
    backend === "x64" ? engine.compileAot(SOURCE, { backend: "x64" }) : engine.compileAot(SOURCE);
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  compiled.set(backend, program);
  return program;
}

function interpret(call: string): string {
  return String(engine.runNative(`${SOURCE}\n${call}`));
}

describe("native string building matches the interpreter", () => {
  itAssembles("builds every string shape the same way the interpreter does", () => {
    const results = runNativeStringBatch(compile("x64"), CASES);

    for (const [index, entry] of CASES.entries()) {
      expect(results[index], entry.call).toBe(interpret(entry.call));
    }
  });

  itAssembles("keeps the C backend in lockstep on one case per string operation", () => {
    const source = cSource(compile("c"));
    const covered = CASES.filter((entry) =>
      ["cat", "render", "charAt", "coefficients"].includes(entry.symbol),
    ).filter((entry, index, all) => all.findIndex((c) => c.symbol === entry.symbol) === index);

    for (const entry of covered) {
      expect(
        runCStringFunction(source, entry.symbol, entry.args as readonly CArgument[]),
        entry.call,
      ).toBe(interpret(entry.call));
    }
  });

  itAssembles("truncates at the buffer capacity instead of overrunning it", () => {
    const limit = AOT_STRING_BUFFER_CAPACITY - 1;
    const [under, over] = runNativeStringBatch(compile("x64"), [
      { symbol: "overflow", args: [102] },
      { symbol: "overflow", args: [200] },
    ]);

    expect(under).toHaveLength(1020);
    expect(over).toHaveLength(limit);
  });
});
