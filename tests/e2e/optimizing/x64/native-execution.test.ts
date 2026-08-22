import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import {
  itAssembles,
  nativeFile,
  runNativeFunction,
  type NativeArgument,
} from "../../../helpers/native-executor.js";
import { cSource, runCFunction, type CArgument } from "../../../helpers/c-executor.js";
import { hostBackendId } from "../../../../src/optimizing/backends/index.js";

const HOST_TARGET = hostBackendId()!;

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, { backend: HOST_TARGET });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  return program;
}

function interpret(source: string, call: string): unknown {
  return nodeEngine({ typecheck: "off" }).runNative(`${source}\n${call}`);
}

function matchesCBackend(
  source: string,
  symbol: string,
  args: readonly NativeArgument[],
): void {
  const viaC = nodeEngine({ typecheck: "off" }).compileAot(source);
  expect(viaC.skipped).toEqual([]);
  const expected = runCFunction(cSource(viaC), symbol, args as readonly CArgument[]);
  expect(runNativeFunction(compile(source), symbol, args)).toBe(expected);
}

function matchesInterpreter(
  source: string,
  symbol: string,
  args: readonly NativeArgument[],
  call: string,
): void {
  const expected = interpret(source, call);
  expect(runNativeFunction(compile(source), symbol, args)).toBe(expected);
}

describe("x64 native execution matches the interpreter", () => {
  itAssembles("runs an integer accumulation loop", () => {
    const source = src(
      "fn total(n: int) -> int:",
      "  acc = 0",
      "  i = 0",
      "  while i < n:",
      "    acc = acc + i * i",
      "    i = i + 1",
      "  return acc",
    );
    matchesInterpreter(source, "total", [10], "total(10)");
  });

  itAssembles("runs nested loops with a float accumulator", () => {
    const source = src(
      "fn grid(n: int) -> float:",
      "  acc = 0.0",
      "  i = 0",
      "  while i < n:",
      "    j = 0",
      "    while j < n:",
      "      acc = acc + i * 0.5 - j * 0.25",
      "      j = j + 1",
      "    i = i + 1",
      "  return acc",
    );
    matchesInterpreter(source, "grid", [7], "grid(7)");
  });

  itAssembles("runs a branch whose arms both feed a phi", () => {
    const source = src(
      "fn pick(a: int, b: int) -> int:",
      "  if a < b:",
      "    r = b - a",
      "  else:",
      "    r = a - b",
      "  return r",
    );
    matchesInterpreter(source, "pick", [3, 11], "pick(3, 11)");
    matchesInterpreter(source, "pick", [11, 3], "pick(11, 3)");
  });

  itAssembles("wraps declared int arithmetic at 32 bits", () => {
    const source = src("fn add_ints(a: int, b: int) -> int:", "  return a + b");
    expect(
      runNativeFunction(compile(source), "add_ints", [1073741824, 1073741824]),
    ).toBe(-2147483648);
  });

  itAssembles("keeps float division in floating point", () => {
    const source = src("fn ratio(a: int, b: int) -> float:", "  return a / b");
    matchesInterpreter(source, "ratio", [7, 2], "ratio(7, 2)");
  });

  itAssembles("calls another compiled function", () => {
    const source = src(
      "fn square(x: float) -> float:",
      "  return x * x",
      "fn hypotenuse(a: float, b: float) -> float:",
      "  return square(a) + square(b)",
    );
    matchesInterpreter(source, "hypotenuse", [3.0, 4.0], "hypotenuse(3.0, 4.0)");
  });

  itAssembles("recurses", () => {
    const source = src(
      "fn fib(n: int) -> int:",
      "  if n < 2:",
      "    return n",
      "  return fib(n - 1) + fib(n - 2)",
    );
    matchesInterpreter(source, "fib", [20], "fib(20)");
  });

  itAssembles("reads and writes a local array through an index", () => {
    const source = src(
      "fn sums(n: int) -> int:",
      "  data = [0, 0, 0, 0]",
      "  i = 0",
      "  while i < 4:",
      "    data[i] = i * n",
      "    i = i + 1",
      "  return data[0] + data[1] + data[2] + data[3]",
    );
    matchesInterpreter(source, "sums", [5], "sums(5)");
  });

  itAssembles("uses bitwise operators on declared ints", () => {
    const source = src(
      "fn mask(a: int, b: int) -> int:",
      "  return ((a & b) | (a ^ b)) << 2",
    );
    matchesInterpreter(source, "mask", [0b1100, 0b1010], "mask(12, 10)");
  });

  itAssembles("evaluates Math intrinsics", () => {
    const source = src(
      "fn shape(x: float) -> float:",
      "  a = Math.abs(x)",
      "  b = Math.floor(x)",
      "  c = Math.min(x, 2.0)",
      "  d = Math.max(x, 2.0)",
      "  return a + b + c + d",
    );
    matchesInterpreter(source, "shape", [-6.25], "shape(-6.25)");
    matchesInterpreter(source, "shape", [6.25], "shape(6.25)");
  });

  itAssembles("takes a square root", () => {
    const source = src("fn root(x: float) -> float:", "  return Math.sqrt(x)");
    matchesInterpreter(source, "root", [6.25], "root(6.25)");
  });

  itAssembles("negates and rounds floats", () => {
    const source = src(
      "fn adjust(x: float) -> float:",
      "  r = Math.round(x)",
      "  t = Math.trunc(x)",
      "  c = Math.ceil(x)",
      "  return -(r + t + c)",
    );
    matchesInterpreter(source, "adjust", [-2.5], "adjust(-2.5)");
    matchesInterpreter(source, "adjust", [2.5], "adjust(2.5)");
  });

  itAssembles("measures a string length", () => {
    const source = src("fn size(s: string) -> int:", "  return s.length");
    expect(runNativeFunction(compile(source), "size", ["abcdef"])).toBe(6);
  });

  itAssembles("compares floats with NaN-correct equality", () => {
    const source = src(
      "fn eq(a: float, b: float) -> int:",
      "  if a == b:",
      "    return 1",
      "  return 0",
    );
    expect(runNativeFunction(compile(source), "eq", [1.5, 1.5])).toBe(1);
    expect(runNativeFunction(compile(source), "eq", [1.5, 2.5])).toBe(0);
    expect(runNativeFunction(compile(source), "eq", [Number.NaN, Number.NaN])).toBe(0);
  });

  itAssembles("returns a comparison result directly", () => {
    const source = src("fn same(a: float, b: float) -> bool:", "  r = a == b", "  return r");
    expect(runNativeFunction(compile(source), "same", [1.5, 1.5])).toBe(1);
    expect(runNativeFunction(compile(source), "same", [1.5, 2.5])).toBe(0);
    expect(runNativeFunction(compile(source), "same", [Number.NaN, Number.NaN])).toBe(0);
  });

  itAssembles("returns an ordered comparison result directly", () => {
    const source = src("fn below(a: int, b: int) -> bool:", "  r = a < b", "  return r");
    expect(runNativeFunction(compile(source), "below", [2, 9])).toBe(1);
    expect(runNativeFunction(compile(source), "below", [9, 2])).toBe(0);
  });

  itAssembles("converts out-of-range doubles with JavaScript ToInt32 semantics", () => {
    const source = src("fn low_bits(x: float) -> int:", "  return x | 0");
    const cases = [0, -1.5, 2147483648, 4294967296, 1e21, -1e21, 2 ** 63 + 2 ** 11];
    for (const value of cases) {
      expect(runNativeFunction(compile(source), "low_bits", [value])).toBe(value | 0);
    }
  });

  itAssembles("reads a character code from a string parameter", () => {
    const source = src("fn code_at(s: string, i: int) -> int:", "  return s.char_code_at(i)");
    expect(runNativeFunction(compile(source), "code_at", ["Hi", 1])).toBe(105);
    expect(() => runNativeFunction(compile(source), "code_at", ["Hi", -1])).toThrow(
      "no character code at that index",
    );
  });

  const INDEXED_LOAD = src(
    "fn at(n: int) -> float:",
    "  data = [1.5, 2.5, 3.5]",
    "  return data[n]",
  );
  const FOLDED_ADD = src("fn bump(a: int) -> int:", "  return a + 7");

  it("emits addressing modes rather than address arithmetic", () => {
    expect(nativeFile(compile(INDEXED_LOAD), ".s")).toMatch(/movsd\s+\d+\(%r\w+,%r\w+,8\)/);
  });

  itAssembles("runs an emitted addressing mode", () => {
    expect(runNativeFunction(compile(INDEXED_LOAD), "at", [2])).toBe(3.5);
  });

  it("folds an integer addition into a lea", () => {
    expect(nativeFile(compile(FOLDED_ADD), ".s")).toMatch(/leal\s+7\(%r\w+\)/);
  });

  itAssembles("runs a folded integer addition", () => {
    expect(runNativeFunction(compile(FOLDED_ADD), "bump", [35])).toBe(42);
  });
});

describe("x64 register pressure", () => {
  itAssembles("spills and reloads when more values are live than there are registers", () => {
    const names = Array.from({ length: 20 }, (_unused, index) => `v${index}`);
    const source = src(
      `fn pressure(x: float) -> float:`,
      ...names.map((name, index) => `  ${name} = x * ${index + 1}.5`),
      `  return ${names.join(" + ")}`,
    );
    const assembly = nativeFile(compile(source), ".s");

    expect(assembly).toMatch(/movsd\s+%xmm\d+, \d+\(%rsp\)/);
    expect(assembly).toMatch(/movsd\s+\d+\(%rsp\), %xmm\d+/);
    matchesInterpreter(source, "pressure", [1.25], "pressure(1.25)");
  });

  itAssembles("spills integers across a call", () => {
    const source = src(
      "fn leaf(x: float) -> float:",
      "  return x + 1.0",
      "fn caller(n: int) -> float:",
      "  a = n + 1",
      "  b = n + 2",
      "  c = n + 3",
      "  d = leaf(1.5)",
      "  return a + b + c + d",
    );
    matchesInterpreter(source, "caller", [4], "caller(4)");
  });

  itAssembles("keeps unsigned shift results above the signed range", () => {
    const source = src("fn ushr(a: int, b: int) -> float:", "  return a >>> b");
    matchesInterpreter(source, "ushr", [-1, 1], "ushr(-1, 1)");
    matchesInterpreter(source, "ushr", [-8, 2], "ushr(-8, 2)");
  });

  itAssembles("matches the C backend on integer remainder edge cases", () => {
    const source = src("fn rem(a: int, b: int) -> int:", "  return (a % b) + 0");
    matchesCBackend(source, "rem", [17, 5]);
    matchesCBackend(source, "rem", [-2147483648, -1]);
    expect(() => runNativeFunction(compile(source), "rem", [17, 0])).toThrow(
      "cannot take the remainder by zero",
    );
  });

  itAssembles("matches the C backend on int32 wraparound and shifts", () => {
    const source = src(
      "fn bits(a: int, b: int) -> int:",
      "  return ((a * b) << 3) + (a >> 1) + (~b)",
    );
    matchesCBackend(source, "bits", [123456789, 987654321]);
    matchesCBackend(source, "bits", [-5, 7]);
  });
});
