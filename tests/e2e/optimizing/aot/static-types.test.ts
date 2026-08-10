import { describe, it, expect } from "vitest";
import { Engine } from "../../../../src/api/engine.js";
import { itNative, runCFunction } from "../../../helpers/c-executor.js";

function compile(source: string) {
  return new Engine().compileAot(source);
}

function bodyOf(program: { source: string }, symbol: string): string {
  const start = program.source.indexOf(`${symbol}(`);
  expect(start).toBeGreaterThan(-1);
  return program.source.slice(start, program.source.indexOf("\n}", start));
}

describe("AOT static typing", () => {
  itNative("selects int32 representations from declared int parameters", () => {
    const program = compile(`fn add_ints(a: int, b: int) -> int:\n  return a + b\n`);

    expect(program.skipped).toEqual([]);
    expect(program.source).toContain("int32_t add_ints(int32_t p0, int32_t p1)");
    expect(program.source).toContain("= tera_i32_add(");
    expect(runCFunction(program.source, "add_ints", [2, 3])).toBe(5);
  });

  itNative("wraps declared int arithmetic at 32 bits", () => {
    const program = compile(`fn add_ints(a: int, b: int) -> int:\n  return a + b\n`);

    expect(runCFunction(program.source, "add_ints", [1073741824, 1073741824])).toBe(-2147483648);
  });

  itNative("keeps declared float arithmetic in floating point", () => {
    const program = compile(`fn add_floats(a: float, b: float) -> float:\n  return a + b\n`);

    expect(program.skipped).toEqual([]);
    expect(program.source).toContain("double add_floats(double p0, double p1)");
    expect(program.source).not.toContain("= tera_i32_add(");
    expect(runCFunction(program.source, "add_floats", [2.5, 7.25])).toBe(9.75);
  });

  itNative("widens mixed int and float operands to floating point", () => {
    const program = compile(`fn mix(a: int, b: float) -> float:\n  return a * b\n`);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "mix")).not.toContain("tera_i32_mul");
    expect(runCFunction(program.source, "mix", [3, 0.5])).toBe(1.5);
  });

  itNative("propagates declared types through a loop carried variable", () => {
    const program = compile(
      `fn total(n: int) -> int:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + i\n    i = i + 1\n  return acc\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(program.source).toContain("int32_t total(int32_t p0)");
    expect(program.source).toContain("= tera_i32_add(");
    expect(runCFunction(program.source, "total", [10])).toBe(45);
  });

  itNative("widens a loop carried variable whose back edge is not an integer", () => {
    const program = compile(
      `fn drift(n: int) -> float:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + 0.5\n    i = i + 1\n  return acc\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(program.source, "drift", [5])).toBe(2.5);
  });

  itNative("keeps a loop counter integral while its accumulator widens", () => {
    const program = compile(
      `fn indexed(n: int) -> float:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + i * 0.25\n    i = i + 1\n  return acc\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "indexed")).toContain("tera_i32_add");
    expect(runCFunction(program.source, "indexed", [5])).toBe(2.5);
  });

  itNative("compiles calls between declared functions", () => {
    const program = compile(
      `fn twice(a: int) -> int:\n  return a + a\n\nfn use_twice(a: int) -> int:\n  return twice(a) + 1\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.name).sort()).toEqual(["twice", "use_twice"]);
    expect(runCFunction(program.source, "use_twice", [20])).toBe(41);
  });

  itNative("takes a callee result type from its declared return type", () => {
    const program = compile(
      `fn half(a: int) -> float:\n  return a / 2\n\nfn scaled(a: int) -> float:\n  return half(a) * 2\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(program.source).toContain("double half(int32_t p0)");
    expect(runCFunction(program.source, "scaled", [7])).toBe(7);
  });

  itNative("types string parameters and their builtin members", () => {
    const program = compile(
      `fn first_code(s: string) -> int:\n  return s.char_code_at(0) + s.length\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(program.source).toContain("int32_t first_code(const char *p0)");
    expect(runCFunction(program.source, "first_code", ["Hi"])).toBe("H".charCodeAt(0) + 2);
  });

  itNative("uses float division for the int division operator", () => {
    const program = compile(`fn ratio(a: int, b: int) -> float:\n  return a / b\n`);

    expect(program.skipped).toEqual([]);
    expect(runCFunction(program.source, "ratio", [7, 2])).toBe(3.5);
  });

  itNative("keeps modulo integral with the sign of the dividend", () => {
    const program = compile(`fn rem(a: int, b: int) -> int:\n  return a % b\n`);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "rem")).toContain("tera_i32_mod");
    expect(runCFunction(program.source, "rem", [-7, 3])).toBe(-7 % 3);
    expect(runCFunction(program.source, "rem", [7, -3])).toBe(7 % -3);
  });

  itNative("keeps bitwise and shift results integral", () => {
    const program = compile(
      `fn bits(a: int, b: int) -> int:\n  return ((a & b) | (a ^ b)) + (a << 2) + (a >> 1)\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(program.source, "bits", [12, 10])).toBe(
      ((12 & 10) | (12 ^ 10)) + (12 << 2) + (12 >> 1),
    );
  });

  itNative("falls back to floating point for undeclared parameters", () => {
    const program = compile(`fn loose(a):\n  return a + 1\n`);

    expect(program.skipped).toEqual([]);
    expect(program.source).toContain("double loose(double p0)");
    expect(runCFunction(program.source, "loose", [41.5])).toBe(42.5);
  });

  itNative("keeps constants outside the int32 range in floating point", () => {
    const program = compile(`fn big() -> float:\n  return 3000000000.0 + 1.0\n`);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "big")).not.toContain("tera_i32_add");
    expect(runCFunction(program.source, "big", [])).toBe(3000000001);
  });

  it("ignores type feedback collected by running the program", () => {
    const source = `fn total(n: int) -> int:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + i\n    i = i + 1\n  return acc\n`;

    const warm = new Engine();
    expect(warm.runNative(`${source}\ntotal(200)\n`)).toBe(19900);
    const warmed = warm.collectFunctions().find((fn) => fn.name === "total");
    expect(warmed?.feedbackVector).toBeTruthy();

    const fromWarmed = warm.compileAotFunctions([warmed!]);
    const fromCold = new Engine().compileAot(source, { functionNames: ["total"] });

    expect(fromWarmed.skipped).toEqual([]);
    expect(fromWarmed.source).toBe(fromCold.source);
  });

  itNative("keeps locals first assigned inside a branch in int32", () => {
    const source = [
      "fn f(n: int) -> int:",
      "  i = 0",
      "  total = 0",
      "  while i < n:",
      "    if i > 2:",
      "      step = i * 3",
      "      total = total + step",
      "    i = i + 1",
      "  return total",
      "",
    ].join("\n");
    const program = compile(source);

    expect(program.skipped).toEqual([]);
    const body = bodyOf(program, "f");
    expect(body).not.toContain("double");
    expect(body).not.toContain("0.0 / 0.0");
    expect(runCFunction(program.source, "f", [9])).toBe(
      Number(new Engine().runNative(`${source}\nf(9)\n`)),
    );
  });

  itNative("compiles without ever executing the program under compilation", () => {
    const program = compile(
      `fn boom(n: int) -> int:\n  return n + 1\n\nboom(1) / 0\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(program.source, "boom", [41])).toBe(42);
  });
});
