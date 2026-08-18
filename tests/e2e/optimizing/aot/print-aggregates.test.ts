import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(
    `${source}\n`,
  );
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function agreesInC(source: string): void {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
    format: "assembly",
  });

  expect(program.skipped).toEqual([]);
  expect(runCProgram(cSource(program)).stdout).toBe(interpreted(source));
}

const PROGRAMS: readonly (readonly [string, string])[] = [
  ["an int array", src("xs: int[] = [1, 2, 3]", "print(xs)")],
  ["a float array", src("xs: float[] = [1.5, 2.0]", "print(xs)")],
  ["a string array", src('xs: string[] = ["a", "b"]', "print(xs)")],
  ["an empty array", src("xs: int[] = []", "print(xs)")],
  ["a single-element array", src("xs: int[] = [7]", "print(xs)")],
  ["an array grown at runtime", src("xs: int[] = []", "for i of range(0, 4):", "  xs.push(i)", "print(xs)")],
  ["an object literal", src('o = { a: 1, b: "x" }', "print(o)")],
  ["a nested-free object literal", src("o = { a: 1, b: 2.5 }", "print(o)")],
  [
    "a class instance",
    src(
      "class P:",
      "  public constructor(x: int, n: string):",
      "    this.x = x",
      "    this.n = n",
      'print(P(1, "bob"))',
    ),
  ],
  ["an array among other arguments", src("xs: int[] = [1, 2]", 'print("mixed", 1, 2.5, xs)')],
  ["two arrays in one call", src("xs: int[] = [1]", "ys: int[] = [2]", "print(xs, ys)")],
  ["an array inside a loop", src("xs: int[] = [1, 2]", "for i of range(0, 2):", "  print(xs)")],
];

describe("printing aggregates", () => {
  for (const [name, source] of PROGRAMS) {
    itRunsPe(`prints ${name} the way the interpreter does`, () => agrees(source));
    itNative(`prints ${name} the same way through the C backend`, () => agreesInC(source));
  }

  it("declines an array whose elements are themselves arrays", () => {
    expect(() =>
      nodeEngine({ typecheck: "off" }).compileAot(
        src("xs: int[][] = [[1, 2], [3]]", "print(xs)", ""),
        { backend: "x64-windows", format: "executable" },
      ),
    ).toThrow(/cannot format a pointer value/);
  });

  itRunsPe("keeps a plain value printing unchanged next to an aggregate", () => {
    const run = runPe(image(src("xs: int[] = [1]", 'print("a")', "print(xs)", 'print("b")')));

    expect(run.stdout).toBe("a\n[1]\nb\n");
  });
});
