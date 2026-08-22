import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, image, interpreted, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

const PROGRAMS: readonly (readonly [string, string])[] = [
  ["an int array", src("xs: int[] = [1, 2, 3]", "print(xs)")],
  ["a float array", src("xs: float[] = [1.5, 2.0]", "print(xs)")],
  ["a string array", src('xs: string[] = ["a", "b"]', "print(xs)")],
  ["an empty array", src("xs: int[] = []", "print(xs)")],
  ["a single-element array", src("xs: int[] = [7]", "print(xs)")],
  ["an array grown at runtime", src("xs: int[] = []", "for i of range(0, 4):", "  xs.push(i)", "print(xs)")],
  ["a bool array", src("xs: bool[] = [true, false]", "print(xs)")],
  ["a bool array built from comparisons", src("xs = [1 < 2, 2 < 1]", "print(xs)")],
  ["an instance with a bool field", src(
    "class P:",
    "  public constructor(f: bool):",
    "    this.f = f",
    "print(P(true), P(false))",
  )],
  ["an instance mixing bool and int fields", src(
    "class P:",
    "  public constructor(n: int, f: bool):",
    "    this.n = n",
    "    this.f = f",
    "print(P(1, true))",
  )],
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
    itRunsPe(`prints ${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`prints ${name} the same way through the C backend`, native.agrees(source));
  }

  it("declines a print of a value it cannot format", () => {
    expect(() =>
      nodeEngine({ typecheck: "off" }).compileAot(src('x = print("hi")', "print(x)", ""), {
        backend: "x64-windows",
        format: "executable",
      }),
    ).toThrow(/cannot format a void value/);
  });

  itRunsPe("keeps a plain value printing unchanged next to an aggregate", () => {
    const run = runPe(image(src("xs: int[] = [1]", 'print("a")', "print(xs)", 'print("b")')));

    expect(run.stdout).toBe("a\n[1]\nb\n");
  });
});
