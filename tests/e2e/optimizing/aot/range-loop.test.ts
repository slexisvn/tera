import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCFunction, runCProgram } from "../../../helpers/c-executor.js";

function compile(lines: readonly string[]) {
  const program = nodeEngine().compileAot(`${lines.join("\n")}\n`);
  expect(program.skipped).toEqual([]);
  return program;
}

function ran(lines: readonly string[]) {
  const program = nodeEngine().compileAot(`${lines.join("\n")}\n`, { wholeProgram: true });
  expect(program.skipped).toEqual([]);
  return runCProgram(cSource(program));
}

const TOTAL = (call: string) => [
  "fn total(a: int, b: int) -> int:",
  "  s = 0",
  `  for i of ${call}:`,
  "    s = s + i",
  "  return s",
];

describe("AOT range loops", () => {
  itNative("counts from zero when range is given one bound", () => {
    const program = compile(TOTAL("range(b)"));

    expect(runCFunction(cSource(program), "total", [0, 5])).toBe(10);
  });

  itNative("counts between the two bounds it is given", () => {
    const program = compile(TOTAL("range(a, b)"));

    expect(runCFunction(cSource(program), "total", [2, 6])).toBe(14);
  });

  itNative("skips by a positive step", () => {
    const program = compile(TOTAL("range(a, b, 2)"));

    expect(runCFunction(cSource(program), "total", [0, 10])).toBe(20);
  });

  itNative("counts down when the step is negative", () => {
    const program = compile(TOTAL("range(a, b, -1)"));

    expect(runCFunction(cSource(program), "total", [5, 0])).toBe(15);
  });

  itNative("runs no iterations when the bounds meet", () => {
    const program = compile(TOTAL("range(a, b)"));

    expect(runCFunction(cSource(program), "total", [3, 3])).toBe(0);
    expect(runCFunction(cSource(program), "total", [6, 2])).toBe(0);
  });

  itNative("counts over a bound the caller computed", () => {
    const program = compile([
      "fn factorial(n: int) -> int:",
      "  acc = 1",
      "  for i of range(1, n + 1):",
      "    acc = acc * i",
      "  return acc",
    ]);

    expect(runCFunction(cSource(program), "factorial", [5])).toBe(120);
  });

  itNative("nests one range loop inside another", () => {
    const program = compile([
      "fn grid(a: int, b: int) -> int:",
      "  s = 0",
      "  for i of range(a):",
      "    for j of range(b):",
      "      s = s + i * j",
      "  return s",
    ]);

    expect(runCFunction(cSource(program), "grid", [3, 4])).toBe(18);
  });

  itNative("prints each value a top level range loop visits", () => {
    expect(ran(["for i of range(3):", "  print(i)"]).stdout).toBe("0\n1\n2\n");
  });

  it("declines a range whose step is only known at run time", () => {
    const program = nodeEngine().compileAot(
      `${TOTAL("range(a, b, a)").join("\n")}\n`,
      { backend: "c" },
    );

    expect(program.skipped.map((fn) => fn.reason).join("; ")).toContain("IteratorInit");
  });

  it("refuses a range over bounds that are not counted in integers", () => {
    expect(() =>
      nodeEngine().compileAot(
        [
          "fn total(a: float, b: float) -> float:",
          "  s = 0.0",
          "  for i of range(a, b):",
          "    s = s + i",
          "  return s",
          "",
        ].join("\n"),
        { backend: "c" },
      ),
    ).toThrow("Type 'float' is not assignable to parameter 'start: int'");
  });
});
