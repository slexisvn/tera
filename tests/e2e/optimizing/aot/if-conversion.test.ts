import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";
import { itAssembles, nativeFile, runNativeFunction } from "../../../helpers/native-executor.js";
import { hostBackendId } from "../../../../src/optimizing/backends/index.js";

const HOST_TARGET = hostBackendId()!;

const src = (...lines: string[]) => lines.join("\n") + "\n";

const CHOOSES = src(
  "fn choose(n: int) -> int:",
  "  acc: int = 0",
  "  if n < 0:",
  "    acc = n + 2",
  "  else:",
  "    acc = n - 1",
  "  return acc",
);

const RAISES = src(
  "fn raise(n: int) -> int:",
  "  acc: int = n",
  "  if n < 0:",
  "    acc = n + 100",
  "  return acc",
);

const SCALES = src(
  "fn scale(n: float) -> float:",
  "  acc: float = n",
  "  if n < 0.0:",
  "    acc = n * -1.5",
  "  else:",
  "    acc = n * 2.5",
  "  return acc",
);

const COUNTS = src(
  "fn counted(n: int) -> int:",
  "  total: int = 0",
  "  i: int = 0",
  "  while i < n:",
  "    if i < 3:",
  "      total = total + 2",
  "    else:",
  "      total = total - 1",
  "    i = i + 1",
  "  return total",
);

function compiledForC(source: string): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source);
  expect(program.skipped).toEqual([]);
  return program;
}

function compiledForHost(source: string): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend: HOST_TARGET,
  });
  expect(program.skipped).toEqual([]);
  return program;
}

describe("AOT if-conversion", () => {
  itNative("answers what the branchy program answered, through C", () => {
    const program = compiledForC(CHOOSES);

    expect(runCFunction(cSource(program), "choose", [-5])).toBe(-3);
    expect(runCFunction(cSource(program), "choose", [5])).toBe(4);
  });

  itNative("selects in one C expression instead of branching", () => {
    expect(cSource(compiledForC(CHOOSES))).toMatch(/\?.*:/);
  });

  itNative("converts a float diamond for a target that selects floats", () => {
    const program = compiledForC(SCALES);

    expect(runCFunction(cSource(program), "scale", [-2])).toBe(3);
    expect(runCFunction(cSource(program), "scale", [2])).toBe(5);
  });

  itAssembles("moves conditionally instead of branching on x64", () => {
    expect(nativeFile(compiledForHost(CHOOSES), ".s")).toMatch(/\bcmov\w+\b/);
  });

  itAssembles("reads the flags the comparison already set", () => {
    const body = nativeFile(compiledForHost(CHOOSES), ".s");

    expect(body).not.toMatch(/\bsete?l?\s+%al\b/);
    expect(body).toMatch(/cmpl[^\n]*\n\s*(movl[^\n]*\n\s*)?cmov/);
  });

  itAssembles("answers what the branchy program answered, on x64", () => {
    const program = compiledForHost(CHOOSES);

    expect(runNativeFunction(program, "choose", [-5])).toBe(-3);
    expect(runNativeFunction(program, "choose", [5])).toBe(4);
  });

  itAssembles("converts a triangle whose else arm is empty", () => {
    const program = compiledForHost(RAISES);

    expect(nativeFile(program, ".s")).toMatch(/\bcmov\w+\b/);
    expect(runNativeFunction(program, "raise", [-5])).toBe(95);
    expect(runNativeFunction(program, "raise", [5])).toBe(5);
  });

  itAssembles("leaves a float diamond branching where the target has no float select", () => {
    expect(nativeFile(compiledForHost(SCALES), ".s")).not.toMatch(/\bcmov\w+\b/);
  });

  itAssembles("converts a diamond inside a loop and keeps its answer", () => {
    const program = compiledForHost(COUNTS);

    expect(nativeFile(program, ".s")).toMatch(/\bcmov\w+\b/);
    expect(runNativeFunction(program, "counted", [10])).toBe(-1);
    expect(runNativeFunction(program, "counted", [2])).toBe(4);
  });
});
