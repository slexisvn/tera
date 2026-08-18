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
  ["finds an int", src("xs: int[] = [1, 2, 3]", "print(xs.index_of(3))")],
  ["reports a missing int as -1", src("xs: int[] = [1, 2, 3]", "print(xs.index_of(9))")],
  ["reports the first of several matches", src("xs: int[] = [5, 5]", "print(xs.index_of(5))")],
  ["searches at the front", src("xs: int[] = [7, 8]", "print(xs.index_of(7))")],
  ["searches an empty array", src("xs: int[] = []", "print(xs.index_of(1))")],
  ["finds a float", src("xs: float[] = [1.5, 2.5]", "print(xs.index_of(2.5))")],
  ["misses a float", src("xs: float[] = [1.5]", "print(xs.index_of(9.5))")],
  ["finds a string", src('xs: string[] = ["a", "b"]', 'print(xs.index_of("b"))')],
  ["misses a string", src('xs: string[] = ["a"]', 'print(xs.index_of("zz"))')],
  ["tells that a value is present", src("xs: int[] = [1, 2, 3]", "print(xs.includes(2))")],
  ["tells that a value is absent", src("xs: int[] = [1, 2, 3]", "print(xs.includes(9))")],
  ["tells that an empty array holds nothing", src("xs: int[] = []", "print(xs.includes(1))")],
  ["tells that a string is present", src('xs: string[] = ["a"]', 'print(xs.includes("a"))')],
  [
    "uses the answer as a condition",
    src("xs: int[] = [1, 2]", "if xs.includes(2):", '  print("yes")', "else:", '  print("no")'),
  ],
  ["searches twice in one statement", src("xs: int[] = [1, 2]", "print(xs.index_of(1), xs.index_of(2))")],
  [
    "searches inside a loop",
    src("xs: int[] = [1, 2]", "n = 0", "while n < 3:", "  print(xs.includes(n))", "  n = n + 1"),
  ],
  [
    "searches an array held by a class",
    src(
      "class Bag:",
      "  public constructor(items: int[]):",
      "    this.items = items",
      "b = Bag([4, 5])",
      "print(b.items.index_of(5))",
    ),
  ],
  [
    "searches inside a function",
    src(
      "fn seen(xs: int[], v: int) -> bool:",
      "  return xs.includes(v)",
      "print(seen([1, 2], 2))",
    ),
  ],
  [
    "keeps searching after the array grows",
    src("xs: int[] = [1]", "xs.push(2)", "xs.push(3)", "print(xs.index_of(3))"),
  ],
];

describe("array search methods", () => {
  for (const [name, source] of PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
    itNative(`${name} the same way through the C backend`, () => agreesInC(source));
  }

  itRunsPe("scans elements in order and stops at the first match", () => {
    const run = runPe(image(src("xs: int[] = [9, 3, 3]", "print(xs.index_of(3))")));

    expect(run.stdout).toBe("1\n");
  });

  it("still declines a member no backend lowers", () => {
    expect(() =>
      nodeEngine({ typecheck: "off" }).compileAot(
        src("xs: int[] = [1]", "print(xs.last_index_of(1))", ""),
        { backend: "x64-windows", format: "executable" },
      ),
    ).toThrow(/last_index_of/);
  });
});
