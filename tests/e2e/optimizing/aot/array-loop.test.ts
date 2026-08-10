import { describe, it, expect } from "vitest";
import { Engine } from "../../../../src/api/engine.js";
import { itNative, runCFunction } from "../../../helpers/c-executor.js";

function compile(lines: readonly string[]) {
  const program = new Engine().compileAot(`${lines.join("\n")}\n`);
  expect(program.skipped).toEqual([]);
  return program;
}

function interpret(lines: readonly string[], call: string): unknown {
  return new Engine().runNative(`${lines.join("\n")}\n${call}\n`);
}

function bodyOf(program: { source: string }, symbol: string): string {
  const start = program.source.indexOf(`${symbol}(`);
  expect(start).toBeGreaterThan(-1);
  return program.source.slice(start, program.source.indexOf("\n}", start));
}

function expectMatchesInterpreter(
  lines: readonly string[],
  entry: string,
  args: readonly number[],
): void {
  const program = compile(lines);
  const interpreted = interpret(lines, `${entry}(${args.join(", ")})`);
  expect(runCFunction(program.source, entry, args)).toBe(interpreted);
}

describe("AOT arrays mutated across loop back-edges", () => {
  itNative("compiles a constant-indexed array store inside a loop", () => {
    const program = compile([
      "fn f() -> int:",
      "  a = [0, 0]",
      "  i = 0",
      "  while i < 3:",
      "    a[0] = a[0] + 1",
      "    i = i + 1",
      "  return a[0]",
    ]);

    expect(runCFunction(program.source, "f", [])).toBe(3);
  });

  itNative("keeps a dynamically indexed array concrete", () => {
    const lines = [
      "fn f(n: int) -> int:",
      "  m = [0, 0, 0, 0]",
      "  i = 0",
      "  while i < n:",
      "    idx = i % 4",
      "    m[idx] = m[idx] + i",
      "    i = i + 1",
      "  return m[0] + m[1] + m[2] + m[3]",
    ];
    const program = compile(lines);

    expect(bodyOf(program, "f")).toContain("] = {");
    expectMatchesInterpreter(lines, "f", [9]);
  });

  itNative("preserves a store made in only one arm of a branch", () => {
    expectMatchesInterpreter(
      [
        "fn f(n: int) -> int:",
        "  m = [0, 0]",
        "  i = 0",
        "  while i < n:",
        "    if i > 1:",
        "      m[1] = m[1] + i",
        "    else:",
        "      m[0] = m[0] + i",
        "    i = i + 1",
        "  return m[0] * 100 + m[1]",
      ],
      "f",
      [6],
    );
  });

  itNative("preserves a store guarded by a branch with no else", () => {
    expectMatchesInterpreter(
      [
        "fn f(n: int) -> int:",
        "  m = [0, 0]",
        "  i = 0",
        "  while i < n:",
        "    if i % 2 == 0:",
        "      m[0] = m[0] + i",
        "    i = i + 1",
        "  return m[0]",
      ],
      "f",
      [7],
    );
  });

  itNative("preserves a store made in a nested inner loop", () => {
    expectMatchesInterpreter(
      [
        "fn f(n: int) -> int:",
        "  m = [0, 0, 0, 0]",
        "  i = 0",
        "  while i < n:",
        "    j = 0",
        "    while j < 4:",
        "      m[j] = m[j] + i",
        "      j = j + 1",
        "    i = i + 1",
        "  return m[0] + m[3]",
      ],
      "f",
      [5],
    );
  });

  itNative("tracks two independent arrays mutated in the same loop", () => {
    expectMatchesInterpreter(
      [
        "fn f(n: int) -> int:",
        "  a = [0, 0]",
        "  b = [0, 0]",
        "  i = 0",
        "  while i < n:",
        "    a[0] = a[0] + i",
        "    b[1] = b[1] + a[0]",
        "    i = i + 1",
        "  return a[0] * 1000 + b[1]",
      ],
      "f",
      [6],
    );
  });

  itNative("compiles a loop that swaps array elements through a temporary", () => {
    const lines = [
      "fn f(n: int) -> int:",
      "  a = [1, 2, 3, 4]",
      "  i = 0",
      "  while i < n:",
      "    t = a[0]",
      "    a[0] = a[3]",
      "    a[3] = t",
      "    i = i + 1",
      "  return a[0] * 10 + a[3]",
    ];
    const program = compile(lines);

    expect(runCFunction(program.source, "f", [3])).toBe(41);
    expectMatchesInterpreter(lines, "f", [4]);
  });

  itNative("keeps float element arrays in floating point", () => {
    const lines = [
      "fn f(n: int) -> float:",
      "  a = [0.0, 0.0]",
      "  i = 0",
      "  while i < n:",
      "    a[0] = a[0] + 0.5",
      "    i = i + 1",
      "  return a[0]",
    ];
    const program = compile(lines);

    expect(runCFunction(program.source, "f", [5])).toBe(2.5);
    expect(interpret(lines, "f(5)")).toBe(2.5);
  });

  itNative("reads a value stored before the loop and again after it", () => {
    expectMatchesInterpreter(
      [
        "fn f(n: int) -> int:",
        "  a = [0, 0]",
        "  a[1] = 7",
        "  i = 0",
        "  while i < n:",
        "    a[0] = a[0] + a[1]",
        "    i = i + 1",
        "  return a[0] + a[1]",
      ],
      "f",
      [4],
    );
  });

  itNative("keeps local arrays concrete instead of scalar replacing them", () => {
    const program = compile([
      "fn f(n: int) -> int:",
      "  a = [3, 4]",
      "  s = 0",
      "  i = 0",
      "  while i < n:",
      "    s = s + a[0] + a[1]",
      "    i = i + 1",
      "  return s",
    ]);

    expect(bodyOf(program, "f")).toContain("int32_t v");
    expect(bodyOf(program, "f")).toContain("] = {");
    expect(runCFunction(program.source, "f", [3])).toBe(21);
  });
});
