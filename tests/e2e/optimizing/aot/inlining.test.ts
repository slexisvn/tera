import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";

const src = (...lines: string[]) => lines.join("\n") + "\n";

const KEEPS_CALLS = compilerOptions("speed", { inlineBudget: 0 });

const CLAMPS = src(
  "fn clamped(n: int) -> int:",
  "  if n < 0:",
  "    return 0",
  "  if n > 100:",
  "    return 100",
  "  return n",
  "fn total(a: int, b: int) -> int:",
  "  return clamped(a) + clamped(b)",
);

const COUNTS = src(
  "fn counted(n: int) -> int:",
  "  acc: int = 0",
  "  i: int = 0",
  "  while i < n:",
  "    acc = acc + i",
  "    i = i + 1",
  "  return acc",
  "fn twice(n: int) -> int:",
  "  return counted(n) + counted(n)",
);

const DECIDES = src(
  "fn picked(n: int, hot: int) -> int:",
  "  if hot == 1:",
  "    return n * 2",
  "  return n + 1",
  "fn go(n: int) -> int:",
  "  return picked(n, 1)",
);

const SPEAKS = src(
  "fn named(n: int) -> string:",
  "  if n < 0:",
  '    return "none"',
  '  return "some"',
  "fn go(n: int) -> string:",
  "  return named(n)",
);

function compile(source: string): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source);
  expect(program.skipped).toEqual([]);
  return program;
}

function withoutInlining(source: string): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
    compilerOptions: KEEPS_CALLS,
  });
  expect(program.skipped).toEqual([]);
  return program;
}

function bodyOf(program: AotProgram, symbol: string): string {
  const source = cSource(program);
  const start = source.search(new RegExp(`^\\w[\\w *]*\\b${symbol}\\(`, "m"));
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}", start));
}

describe("AOT inlining of callees that branch", () => {
  itNative("answers what the call answered, twice over", () => {
    const program = compile(CLAMPS);

    expect(runCFunction(cSource(program), "total", [-5, 200])).toBe(100);
    expect(runCFunction(cSource(program), "total", [7, 8])).toBe(15);
  });

  itNative("leaves no call to the branching callee behind", () => {
    expect(bodyOf(compile(CLAMPS), "total")).not.toContain("clamped(");
    expect(bodyOf(withoutInlining(CLAMPS), "total")).toContain("clamped(");
  });

  itNative("splices a callee that loops and keeps its answer", () => {
    const program = compile(COUNTS);

    expect(bodyOf(program, "twice")).not.toContain("counted(");
    expect(runCFunction(cSource(program), "twice", [10])).toBe(90);
  });

  itNative("folds the branch a constant argument decides", () => {
    const program = compile(DECIDES);

    expect(bodyOf(program, "go")).not.toContain("picked(");
    expect(runCFunction(cSource(program), "go", [21])).toBe(42);
  });

  itNative("refuses a callee that answers a string", () => {
    expect(bodyOf(compile(SPEAKS), "go")).toContain("named(");
  });
});
