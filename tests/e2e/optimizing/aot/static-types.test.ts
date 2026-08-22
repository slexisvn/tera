import { describe, it, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";
import { cCalls } from "../../../helpers/aot-agreement.js";

function compile(source: string) {
  return nodeEngine().compileAot(source);
}

const native = cCalls({
  toC: (source: string) => cSource(compile(source)),
  interpret: (source: string, call: string) => nodeEngine().runNative(`${source}\n${call}\n`),
});

function bodyOf(program: { source: string }, symbol: string): string {
  const start = cSource(program).search(new RegExp(`\\b${symbol}\\(`));
  expect(start).toBeGreaterThan(-1);
  return cSource(program).slice(start, cSource(program).indexOf("\n}", start));
}

const ADD_INTS = `fn add_ints(a: int, b: int) -> int:\n  return a + b\n`;
const ADD_FLOATS = `fn add_floats(a: float, b: float) -> float:\n  return a + b\n`;
const MIX = `fn mix(a: int, b: float) -> float:\n  return a * b\n`;
const TOTAL = `fn total(n: int) -> int:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + i\n    i = i + 1\n  return acc\n`;
const DRIFT = `fn drift(n: int) -> float:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + 0.5\n    i = i + 1\n  return acc\n`;
const INDEXED = `fn indexed(n: int) -> float:\n  acc = 0\n  i = 0\n  while i < n:\n    acc = acc + i * 0.25\n    i = i + 1\n  return acc\n`;
const TWICE = `fn twice(a: int) -> int:\n  return a + a\n\nfn use_twice(a: int) -> int:\n  return twice(a) + 1\n`;
const SCALED = `fn half(a: int) -> float:\n  return a / 2\n\nfn scaled(a: int) -> float:\n  return half(a) * 2\n`;
const FIRST_CODE = `fn first_code(s: string) -> int:\n  return s.char_code_at(0) + s.length\n`;
const CODE_AT = `fn code_at(s: string, i: int) -> int:\n  return s.char_code_at(i)\n`;
const CHECKSUM = `fn checksum(s: string) -> int:\n  acc = 0\n  i = 0\n  while i < s.length:\n    acc = acc + s.char_code_at(i)\n    i = i + 1\n  return acc\n`;
const SIZE = `fn size(s: string) -> int:\n  return s.length\n`;
const RATIO = `fn ratio(a: int, b: int) -> float:\n  return a / b\n`;
const REM = `fn rem(a: int, b: int) -> int:\n  return a % b\n`;
const BITS = `fn bits(a: int, b: int) -> int:\n  return ((a & b) | (a ^ b)) + (a << 2) + (a >> 1)\n`;
const LOOSE = `fn loose(a: float) -> float:\n  return a + 1\n`;
const BIG = `fn big() -> float:\n  return 3000000000.0 + 1.0\n`;
const BOOM = `fn boom(n: int) -> int:\n  return n + 1\n\nboom(1) / 0\n`;
const BRANCH_LOCAL = [
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

const NO_CHARACTER_CODE = "no character code at that index";

describe("AOT static typing", () => {
  it("selects int32 representations from declared int parameters", () => {
    const program = compile(ADD_INTS);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("int32_t add_ints(int32_t p0, int32_t p1)");
    expect(cSource(program)).toContain("= tera_i32_add(");
  });

  itNative("adds declared ints", native.value(ADD_INTS, "add_ints", [2, 3], 5));

  itNative(
    "wraps declared int arithmetic at 32 bits",
    native.value(ADD_INTS, "add_ints", [1073741824, 1073741824], -2147483648),
  );

  it("keeps declared float arithmetic in floating point", () => {
    const program = compile(ADD_FLOATS);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("double add_floats(double p0, double p1)");
    expect(cSource(program)).not.toContain("= tera_i32_add(");
  });

  itNative("adds declared floats", native.value(ADD_FLOATS, "add_floats", [2.5, 7.25], 9.75));

  it("widens mixed int and float operands to floating point", () => {
    const program = compile(MIX);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "mix")).not.toContain("tera_i32_mul");
  });

  itNative("multiplies a mixed pair as floating point", native.value(MIX, "mix", [3, 0.5], 1.5));

  it("propagates declared types through a loop carried variable", () => {
    const program = compile(TOTAL);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("int32_t total(int32_t p0)");
    expect(cSource(program)).toContain("= tera_i32_add(");
  });

  itNative("sums a declared int loop", native.value(TOTAL, "total", [10], 45));

  it("widens a loop carried variable whose back edge is not an integer", () => {
    expect(compile(DRIFT).skipped).toEqual([]);
  });

  itNative("accumulates the widened loop variable", native.value(DRIFT, "drift", [5], 2.5));

  it("keeps a loop counter integral while its accumulator widens", () => {
    const program = compile(INDEXED);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "indexed")).toContain("tera_i32_add");
  });

  itNative("accumulates with an integral counter", native.value(INDEXED, "indexed", [5], 2.5));

  it("compiles calls between declared functions", () => {
    const program = compile(TWICE);

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.name).sort()).toEqual([
      "tera_program",
      "twice",
      "use_twice",
    ]);
  });

  itNative("runs a call between declared functions", native.value(TWICE, "use_twice", [20], 41));

  it("takes a callee result type from its declared return type", () => {
    const program = compile(SCALED);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("double half(int32_t p0)");
  });

  itNative("runs a call through a declared return type", native.value(SCALED, "scaled", [7], 7));

  it("types string parameters and their builtin members", () => {
    const program = compile(FIRST_CODE);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("int32_t first_code(const char *p0)");
  });

  itNative(
    "reads a string parameter and its builtin members",
    native.value(FIRST_CODE, "first_code", ["Hi"], "H".charCodeAt(0) + 2),
  );

  it("lowers a declared string method to a named runtime helper", () => {
    const program = compile(CODE_AT);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("tera_string_char_code_at(const char *value, int32_t index)");
    expect(cSource(program)).toContain("= tera_string_char_code_at(p0, p1);");
  });

  it("reads every code unit of a string in a loop", () => {
    expect(compile(CHECKSUM).skipped).toEqual([]);
  });

  itNative(
    "sums every code unit of a string",
    native.value(
      CHECKSUM,
      "checksum",
      ["tera"],
      [..."tera"].reduce((acc, ch) => acc + ch.charCodeAt(0), 0),
    ),
  );

  it("lowers a string length getter to a named runtime helper", () => {
    const program = compile(SIZE);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("tera_string_length(const char *value)");
    expect(cSource(program)).toContain("= tera_string_length(p0);");
  });

  it("measures a loop-invariant length before the loop rather than inside it", () => {
    const program = compile(CHECKSUM);
    const body = cSource(program).slice(cSource(program).indexOf("int32_t checksum"));

    expect(program.skipped).toEqual([]);
    expect(body.split("tera_string_length(p0)")).toHaveLength(2);
    expect(body.indexOf("tera_string_length(p0)")).toBeLessThan(body.indexOf("L1:"));
  });

  itNative("reads a character code in range", native.value(CODE_AT, "code_at", ["Hi", 1], "i".charCodeAt(0)));

  itNative(
    "faults below the first character code, where the interpreter answers NaN",
    native.faults(CODE_AT, "code_at", ["Hi", -1], NO_CHARACTER_CODE),
  );

  itNative(
    "faults past the last character code, where the interpreter answers NaN",
    native.faults(CODE_AT, "code_at", ["Hi", 2], NO_CHARACTER_CODE),
  );

  it("declines a builtin method call on a receiver whose type it cannot tell", () => {
    const program = compile(`fn code_at(s: string, i: int):\n  return s.length.char_code_at(i)\n`);

    expect(program.compiled.map((fn) => fn.name)).toEqual(["tera_program"]);
    expect(program.skipped.map((fn) => fn.reason)).toContain(
      "C backend cannot emit: unsupported property char_code_at",
    );
  });

  it("uses float division for the int division operator", () => {
    expect(compile(RATIO).skipped).toEqual([]);
  });

  itNative("divides declared ints as floats", native.value(RATIO, "ratio", [7, 2], 3.5));

  it("keeps modulo integral with the sign of the dividend", () => {
    const program = compile(REM);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "rem")).toContain("tera_i32_mod");
  });

  itNative("takes the sign of a negative dividend", native.value(REM, "rem", [-7, 3], -7 % 3));

  itNative("takes the sign of a positive dividend", native.value(REM, "rem", [7, -3], 7 % -3));

  it("keeps bitwise and shift results integral", () => {
    expect(compile(BITS).skipped).toEqual([]);
  });

  itNative(
    "computes bitwise and shift results",
    native.value(BITS, "bits", [12, 10], ((12 & 10) | (12 ^ 10)) + (12 << 2) + (12 >> 1)),
  );

  it("refuses a parameter the source left undeclared", () => {
    expect(() => compile(`fn loose(a):\n  return a + 1\n`)).toThrow(
      "loose: parameter 'a' has no declared type; declare it (for example 'a: int'), " +
        "or keep this part interpreted",
    );
  });

  it("compiles the same function once its parameter is declared", () => {
    const program = compile(LOOSE);

    expect(program.skipped).toEqual([]);
    expect(cSource(program)).toContain("double loose(double p0)");
  });

  itNative("runs the function once its parameter is declared", native.value(LOOSE, "loose", [41.5], 42.5));

  it("keeps constants outside the int32 range in floating point", () => {
    const program = compile(BIG);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "big")).not.toContain("tera_i32_add");
  });

  itNative("adds constants outside the int32 range", native.value(BIG, "big", [], 3000000001));

  it("ignores type feedback collected by running the program", () => {
    const warm = nodeEngine();
    expect(warm.runNative(`${TOTAL}\ntotal(200)\n`)).toBe(19900);
    const warmed = warm.collectFunctions().find((fn) => fn.name === "total");
    expect(warmed?.feedbackVector).toBeTruthy();

    const fromWarmed = warm.compileAotFunctions([warmed!]);
    const fromCold = nodeEngine().compileAot(TOTAL, { functionNames: ["total"] });

    expect(fromWarmed.skipped).toEqual([]);
    expect(fromWarmed.source).toBe(fromCold.source);
  });

  it("keeps locals first assigned inside a branch in int32", () => {
    const program = compile(BRANCH_LOCAL);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "f")).not.toContain("double");
    expect(bodyOf(program, "f")).not.toContain("0.0 / 0.0");
  });

  itNative("runs locals first assigned inside a branch", native.matches(BRANCH_LOCAL, "f", [9]));

  it("compiles without ever executing the program under compilation", () => {
    expect(compile(BOOM).skipped).toEqual([]);
  });

  itNative("runs a function whose module body would fault", native.value(BOOM, "boom", [41], 42));
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

  const RENDER = sourceOf(
    "fn render() -> string:",
    '  page = Report("[", "]")',
    "  return page.header() + page.footer()",
  );

  const MATCHES = sourceOf(
    "fn matches(left: string, right: string) -> int:",
    '  one = Report(left, "]")',
    '  other = Report(right, "]")',
    "  if one.opening == other.opening:",
    "    return 1",
    "  return 0",
  );

  const BOTH = [
    "class Label:",
    "  public text: string",
    "  public constructor(text: string):",
    "    this.text = text",
    "  public get shown() -> string:",
    "    return this.text",
    "fn both(left: string, right: string) -> string:",
    "  return Label(left).shown + Label(right).shown",
    "",
  ].join("\n");

  it("joins two declared string method results as text", () => {
    const program = compile(RENDER);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "render")).not.toContain("tera_f64_add(");
  });

  itNative("runs the joined string method results", native.text(RENDER, "render", [], "[]"));

  it("compares two declared string fields as text", () => {
    const program = compile(MATCHES);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "matches")).not.toContain("tera_f64_compare(");
  });

  itNative("finds two equal string fields", native.value(MATCHES, "matches", ["ab", "ab"], 1));

  itNative("finds two differing string fields", native.value(MATCHES, "matches", ["ab", "cd"], 0));

  it("reads a declared getter result at its declared type", () => {
    const program = compile(BOTH);

    expect(program.skipped).toEqual([]);
    expect(bodyOf(program, "both")).not.toContain("tera_f64_add(");
  });

  itNative("joins two declared getter results", native.text(BOTH, "both", ["ab", "cd"], "abcd"));
});
