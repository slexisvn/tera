import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";
import { itAssembles, nativeFile, runNativeFunction } from "../../../helpers/native-executor.js";
import { hostBackendId } from "../../../../src/optimizing/backends/index.js";

const HOST_TARGET = hostBackendId()!;

const src = (...lines: string[]) => lines.join("\n") + "\n";

const GUARDED = src(
  "fn totalled(n: int, flag: int) -> int:",
  "  acc: int = 0",
  "  i: int = 0",
  "  while i < n:",
  "    if flag == 1:",
  "      acc = acc + i",
  "      acc = acc + 3",
  "    else:",
  "      acc = acc - i",
  "      acc = acc - 2",
  "    i = i + 1",
  "  return acc",
);

const VARYING = src(
  "fn stepped(n: int) -> int:",
  "  acc: int = 0",
  "  i: int = 0",
  "  while i < n:",
  "    if i < 4:",
  "      acc = acc + 2",
  "    else:",
  "      acc = acc - 1",
  "    i = i + 1",
  "  return acc",
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

function loopBackEdges(assembly: string): number {
  const lines = assembly.split(/\r?\n/);
  const lineOf = new Map<string, number>();
  lines.forEach((line, at) => {
    const label = /^([.\w$]+):/.exec(line.trim());
    if (label !== null) lineOf.set(label[1]!, at);
  });
  let closed = 0;
  lines.forEach((line, at) => {
    const taken = /^\s+j(?!mp\b)\w+\s+([.\w$]+)\s*$/.exec(line);
    const target = taken === null ? undefined : lineOf.get(taken[1]!);
    if (target !== undefined && target < at) closed++;
  });
  return closed;
}

describe("AOT loop unswitching", () => {
  itNative("answers what the guarded loop answered, through C", () => {
    const program = compiledForC(GUARDED);

    expect(runCFunction(cSource(program), "totalled", [10, 1])).toBe(75);
    expect(runCFunction(cSource(program), "totalled", [10, 0])).toBe(-65);
  });

  itAssembles("answers what the guarded loop answered, on x64", () => {
    const program = compiledForHost(GUARDED);

    expect(runNativeFunction(program, "totalled", [10, 1])).toBe(75);
    expect(runNativeFunction(program, "totalled", [10, 0])).toBe(-65);
    expect(runNativeFunction(program, "totalled", [0, 1])).toBe(0);
  });

  itAssembles("leaves the guarded loop with one copy per answer", () => {
    expect(loopBackEdges(nativeFile(compiledForHost(GUARDED), ".s"))).toBe(2);
  });

  itAssembles("leaves a loop whose condition changes with it as one copy", () => {
    const program = compiledForHost(VARYING);

    expect(loopBackEdges(nativeFile(program, ".s"))).toBe(1);
    expect(runNativeFunction(program, "stepped", [10])).toBe(2);
  });
});
