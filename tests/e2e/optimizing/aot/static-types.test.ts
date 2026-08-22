import { describe, it, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import {
  cSource,
  itNative,
  runCFunction,
  runCStringFunction,
} from "../../../helpers/c-executor.js";

function compile(source: string) {
  return nodeEngine().compileAot(source);
}

function bodyOf(program: { source: string }, symbol: string): string {
  const start = cSource(program).search(new RegExp(`\\b${symbol}\\(`));
  expect(start).toBeGreaterThan(-1);
  return cSource(program).slice(start, cSource(program).indexOf("\n}", start));
}

describe("AOT static typing", () => {
  itNative("selects int32 representations from declared int parameters", () => {
    const program = compile(`fn add_ints(a: int, b: int) -> int:\n  return a + b\n`);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("int32_t add_ints(int32_t p0, int32_t p1)");
    expect(cSource(program)).toContain("= tera_i32_add(");
    expect(runCFunction(cSource(program), "add_ints", [2, 3])).toBe(5);
  });

  itNative("wraps declared int arithmetic at 32 bits", () => {
    const program = compile(`fn add_ints(a: int, b: int) -> int:\n  return a + b\n`);

    expect(runCFunction(cSource(program), "add_ints", [1073741824, 1073741824])).toBe(-2147483648);
  });

  itNative("keeps declared float arithmetic in floating point", () => {
    const program = compile(`fn add_floats(a: float, b: float) -> float:\n  return a + b\n`);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("double add_floats(double p0, double p1)");
    expect(cSource(program)).not.toContain("= tera_i32_add(");
    expect(runCFunction(cSource(program), "add_floats", [2.5, 7.25])).toBe(9.75);
  });

  itNative("widens mixed int and float operands to floating point", () => {
    const program = compile(`fn mix(a: int, b: float) -> float:\n  return a * b\n`);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "mix")).not.toContain("tera_i32_mul");
    expect(runCFunction(cSource(program), "mix", [3, 0.5])).toBe(1.5);
  });

  itNative("propagates declared types through a loop carried variable", () => {
    const program = compile(
      `fn total(n: int) -> int:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + i\n    i = i + 1\n  return acc\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("int32_t total(int32_t p0)");
    expect(cSource(program)).toContain("= tera_i32_add(");
    expect(runCFunction(cSource(program), "total", [10])).toBe(45);
  });

  itNative("widens a loop carried variable whose back edge is not an integer", () => {
    const program = compile(
      `fn drift(n: int) -> float:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + 0.5\n    i = i + 1\n  return acc\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "drift", [5])).toBe(2.5);
  });

  itNative("keeps a loop counter integral while its accumulator widens", () => {
    const program = compile(
      `fn indexed(n: int) -> float:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + i * 0.25\n    i = i + 1\n  return acc\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "indexed")).toContain("tera_i32_add");
    expect(runCFunction(cSource(program), "indexed", [5])).toBe(2.5);
  });

  itNative("compiles calls between declared functions", () => {
    const program = compile(
      `fn twice(a: int) -> int:\n  return a + a\n\nfn use_twice(a: int) -> int:\n  return twice(a) + 1\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.name).sort()).toEqual([
      "tera_program",
      "twice",
      "use_twice",
    ]);
    expect(runCFunction(cSource(program), "use_twice", [20])).toBe(41);
  });

  itNative("takes a callee result type from its declared return type", () => {
    const program = compile(
      `fn half(a: int) -> float:\n  return a / 2\n\nfn scaled(a: int) -> float:\n  return half(a) * 2\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("double half(int32_t p0)");
    expect(runCFunction(cSource(program), "scaled", [7])).toBe(7);
  });

  itNative("types string parameters and their builtin members", () => {
    const program = compile(
      `fn first_code(s: string) -> int:\n  return s.char_code_at(0) + s.length\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("int32_t first_code(const char *p0)");
    expect(runCFunction(cSource(program), "first_code", ["Hi"])).toBe("H".charCodeAt(0) + 2);
  });

  it("lowers a declared string method to a named runtime helper", () => {
    const program = compile(`fn code_at(s: string, i: int) -> int:\n  return s.char_code_at(i)\n`);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("tera_string_char_code_at(const char *value, int32_t index)");
    expect(cSource(program)).toContain("= tera_string_char_code_at(p0, p1);");
  });

  itNative("reads every code unit of a string in a loop", () => {
    const program = compile(
      `fn checksum(s: string) -> int:\n  acc = 0\n  i = 0\n  while i < s.length:\n    acc = acc + s.char_code_at(i)\n    i = i + 1\n  return acc\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "checksum", ["tera"])).toBe(
      [..."tera"].reduce((acc, ch) => acc + ch.charCodeAt(0), 0),
    );
  });

  it("lowers a string length getter to a named runtime helper", () => {
    const program = compile(`fn size(s: string) -> int:\n  return s.length\n`);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("tera_string_length(const char *value)");
    expect(cSource(program)).toContain("= tera_string_length(p0);");
  });

  it("measures a loop-invariant length before the loop rather than inside it", () => {
    const program = compile(
      `fn checksum(s: string) -> int:\n  acc = 0\n  i = 0\n  while i < s.length:\n    acc = acc + s.char_code_at(i)\n    i = i + 1\n  return acc\n`,
    );
    const body = cSource(program).slice(cSource(program).indexOf("int32_t checksum"));

    expect(program.skipped).toEqual([]);
    expect(body.split("tera_string_length(p0)")).toHaveLength(2);
    expect(body.indexOf("tera_string_length(p0)")).toBeLessThan(body.indexOf("L1:"));
  });

  itNative("faults on an index with no character code, where the interpreter answers NaN", () => {
    const program = compile(`fn code_at(s: string, i: int) -> int:\n  return s.char_code_at(i)\n`);

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "code_at", ["Hi", 1])).toBe("i".charCodeAt(0));
    expect(() => runCFunction(cSource(program), "code_at", ["Hi", -1])).toThrow(
      "no character code at that index",
    );
    expect(() => runCFunction(cSource(program), "code_at", ["Hi", 2])).toThrow(
      "no character code at that index",
    );
  });

  it("declines a builtin method call on a receiver whose type it cannot tell", () => {
    const program = compile(`fn code_at(s: string, i: int):\n  return s.length.char_code_at(i)\n`);

    expect(program.compiled.map((fn) => fn.name)).toEqual(["tera_program"]);
    expect(program.skipped.map((fn) => fn.reason)).toContain(
      "C backend cannot emit: unsupported property char_code_at",
    );
  });

  itNative("uses float division for the int division operator", () => {
    const program = compile(`fn ratio(a: int, b: int) -> float:\n  return a / b\n`);

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "ratio", [7, 2])).toBe(3.5);
  });

  itNative("keeps modulo integral with the sign of the dividend", () => {
    const program = compile(`fn rem(a: int, b: int) -> int:\n  return a % b\n`);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "rem")).toContain("tera_i32_mod");
    expect(runCFunction(cSource(program), "rem", [-7, 3])).toBe(-7 % 3);
    expect(runCFunction(cSource(program), "rem", [7, -3])).toBe(7 % -3);
  });

  itNative("keeps bitwise and shift results integral", () => {
    const program = compile(
      `fn bits(a: int, b: int) -> int:\n  return ((a & b) | (a ^ b)) + (a << 2) + (a >> 1)\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "bits", [12, 10])).toBe(
      ((12 & 10) | (12 ^ 10)) + (12 << 2) + (12 >> 1),
    );
  });

  it("refuses a parameter the source left undeclared", () => {
    expect(() => compile(`fn loose(a):\n  return a + 1\n`)).toThrow(
      "loose: parameter 'a' has no declared type; declare it (for example 'a: int'), " +
        "or keep this part interpreted",
    );
  });

  itNative("compiles the same function once its parameter is declared", () => {
    const program = compile(`fn loose(a: float) -> float:\n  return a + 1\n`);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("double loose(double p0)");
    expect(runCFunction(cSource(program), "loose", [41.5])).toBe(42.5);
  });

  itNative("keeps constants outside the int32 range in floating point", () => {
    const program = compile(`fn big() -> float:\n  return 3000000000.0 + 1.0\n`);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "big")).not.toContain("tera_i32_add");
    expect(runCFunction(cSource(program), "big", [])).toBe(3000000001);
  });

  it("ignores type feedback collected by running the program", () => {
    const source = `fn total(n: int) -> int:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + i\n    i = i + 1\n  return acc\n`;

    const warm = nodeEngine();
    expect(warm.runNative(`${source}\ntotal(200)\n`)).toBe(19900);
    const warmed = warm.collectFunctions().find((fn) => fn.name === "total");
    expect(warmed?.feedbackVector).toBeTruthy();

    const fromWarmed = warm.compileAotFunctions([warmed!]);
    const fromCold = nodeEngine().compileAot(source, { functionNames: ["total"] });

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
    expect(runCFunction(cSource(program), "f", [9])).toBe(
      Number(nodeEngine().runNative(`${source}\nf(9)\n`)),
    );
  });

  itNative("compiles without ever executing the program under compilation", () => {
    const program = compile(
      `fn boom(n: int) -> int:\n  return n + 1\n\nboom(1) / 0\n`,
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "boom", [41])).toBe(42);
  });
});

describe("AOT typing of declared class members", () => {
  const REPORT = [
    "class Report:",
    "  public opening: string",
    "  public closing: string",
    "  public constructor(opening: string, closing: string):",
    "    this.opening = opening",
    "    this.closing = closing",
    "  public header() -> string:",
    "    return this.opening",
    "  public footer() -> string:",
    "    return this.closing",
  ];

  const sourceOf = (...lines: readonly string[]): string =>
    `${[...REPORT, ...lines].join("\n")}\n`;

  itNative("joins two declared string method results as text", () => {
    const program = compile(
      sourceOf(
        "fn render() -> string:",
        '  page = Report("[", "]")',
        "  return page.header() + page.footer()",
      ),
    );

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "render")).not.toContain("tera_f64_add(");
    expect(runCStringFunction(cSource(program), "render", [])).toBe("[]");
  });

  itNative("compares two declared string fields as text", () => {
    const program = compile(
      sourceOf(
        "fn matches(left: string, right: string) -> int:",
        '  one = Report(left, "]")',
        '  other = Report(right, "]")',
        "  if one.opening == other.opening:",
        "    return 1",
        "  return 0",
      ),
    );

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "matches")).not.toContain("tera_f64_compare(");
    expect(runCFunction(cSource(program), "matches", ["ab", "ab"])).toBe(1);
    expect(runCFunction(cSource(program), "matches", ["ab", "cd"])).toBe(0);
  });

  itNative("reads a declared getter result at its declared type", () => {
    const program = compile(
      [
        "class Label:",
        "  public text: string",
        "  public constructor(text: string):",
        "    this.text = text",
        "  public get shown() -> string:",
        "    return this.text",
        "fn both(left: string, right: string) -> string:",
        "  return Label(left).shown + Label(right).shown",
        "",
      ].join("\n"),
    );

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "both")).not.toContain("tera_f64_add(");
    expect(runCStringFunction(cSource(program), "both", ["ab", "cd"])).toBe("abcd");
  });
});
