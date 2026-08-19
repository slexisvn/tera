import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

const POINT = ["class P:", "  public constructor(n: int):", "    this.n = n"];
const AT = ["fn at(xs: int[], i: int) -> int:", "  return xs[i]"];
const OUT_OF_RANGE = "array index is out of range";

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

const IN_RANGE: readonly (readonly [string, string])[] = [
  ["reads the last element through -1", src("xs: int[] = [1, 2, 3]", "print(xs[-1])")],
  ["reads the first element through -length", src("xs: int[] = [1, 2, 3]", "print(xs[-3])")],
  ["reads the last float through -1", src("xs: float[] = [1.5, 2.5]", "print(xs[-1])")],
  ["reads the last string through -1", src('xs: string[] = ["a", "b"]', "print(xs[-1])")],
  [
    "reads a member of the last object through -1",
    src(...POINT, "ps: P[] = [P(1), P(2)]", "print(ps[-1].n)"),
  ],
  ["reads the front element through 0", src("xs: int[] = [1, 2, 3]", "print(xs[0])")],
  [
    "reads the last element through length - 1",
    src("xs: int[] = [1, 2, 3]", "print(xs[xs.length - 1])"),
  ],
  [
    "writes through -1 and reads the slot back through a positive index",
    src("xs: int[] = [1, 2, 3]", "xs[-1] = 9", "print(xs[2])"),
  ],
  [
    "writes through -1 and reads the slot back through -1",
    src("xs: int[] = [1, 2, 3]", "xs[-1] = 9", "print(xs[-1])"),
  ],
  [
    "writes a float through -2",
    src("xs: float[] = [1.5, 2.5]", "xs[-2] = 9.5", "print(xs[0])"),
  ],
  [
    "writes a string through -1",
    src('xs: string[] = ["a", "b"]', 'xs[-1] = "z"', "print(xs[1])"),
  ],
  [
    "counts back from an index only known at run time",
    src("xs: int[] = [1, 2, 3]", "n = 0 - 2", "print(xs[n])"),
  ],
  [
    "counts back inside a function that was handed the array",
    src(...AT, "print(at([1, 2, 3], 0 - 2))"),
  ],
  [
    "counts back into an array a class holds",
    src(
      "class Bag:",
      "  public constructor(items: int[]):",
      "    this.items = items",
      "b = Bag([4, 5, 6])",
      "print(b.items[-1])",
    ),
  ],
  [
    "counts back from the length a push grew",
    src("xs: int[] = [1]", "xs.push(2)", "xs.push(3)", "print(xs[-1])"),
  ],
  [
    "counts back from the length a pop shrank",
    src("xs: int[] = [1, 2, 3]", "xs.pop()", "print(xs[-1])"),
  ],
  [
    "counts back from the length a shift shrank",
    src("xs: int[] = [1, 2, 3]", "xs.shift()", "print(xs[-1])"),
  ],
  [
    "walks the whole array backwards through negative indices",
    src("xs: int[] = [1, 2, 3]", "i = 1", "while i <= 3:", "  print(xs[0 - i])", "  i = i + 1"),
  ],
  [
    "walks the whole array forwards through positive indices",
    src("xs: int[] = [1, 2, 3]", "i = 0", "while i < 3:", "  print(xs[i])", "  i = i + 1"),
  ],
  [
    "reads every element of a for-of walk, which indexes no further than the length",
    src("total = 0", "for x of [1, 2, 3]:", "  total = total + x", "print(total)"),
  ],
];

const BEYOND_THE_ENDS: readonly (readonly [string, string])[] = [
  ["reading one past the end", src("xs: int[] = [1, 2, 3]", "print(xs[3])")],
  ["reading far past the end", src("xs: int[] = [1, 2]", "print(xs[5])")],
  ["reading one before the start", src("xs: int[] = [1, 2, 3]", "print(xs[-4])")],
  ["reading anything out of an empty array", src("xs: int[] = []", "print(xs[0])")],
  [
    "writing one past the end",
    src("xs: int[] = [1, 2, 3]", "xs[3] = 9", 'print("done")'),
  ],
  [
    "writing to an empty array through -1",
    src("xs: int[] = []", "xs[-1] = 9", 'print("done")'),
  ],
  [
    "reading the slot a pop released",
    src("xs: int[] = [1, 2, 3]", "xs.pop()", "print(xs[2])"),
  ],
  [
    "reading past the length into the capacity a push left over",
    src("xs: int[] = [1]", "xs.push(2)", "print(xs[2])"),
  ],
  ["reading out of range inside a callee", src(...AT, "print(at([1, 2], 9))")],
  [
    "counting back further than an index known only at run time may",
    src("xs: int[] = [1, 2, 3]", "n = 0 - 7", "print(xs[n])"),
  ],
];

describe("negative array subscripts count back from the end", () => {
  for (const [name, source] of IN_RANGE) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
    itNative(`${name} the same way through the C backend`, () => agreesInC(source));
  }
});

describe("array subscripts beyond either end fault, where the interpreter answers undefined", () => {
  for (const [name, source] of BEYOND_THE_ENDS) {
    itRunsPe(`faults on ${name}`, () => {
      const run = runPe(image(source));

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(OUT_OF_RANGE);
      expect(run.stdout).toBe("");
    });

    itNative(`faults on ${name} through the C backend`, () => {
      const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
        backend: "c",
        format: "assembly",
      });

      expect(program.skipped).toEqual([]);
      expect(runCProgram(cSource(program)).status).not.toBe(0);
    });
  }

  itRunsPe("keeps the output the program wrote before the subscript it faulted on", () => {
    const run = runPe(image(src("xs: int[] = [1]", 'print("before")', "print(xs[7])")));

    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("before\n");
    expect(run.stderr).toContain(OUT_OF_RANGE);
  });

  itRunsPe("leaves the fault uncatchable, the way an empty pop already is", () => {
    const caught = (statement: string) =>
      runPe(image(src("xs: int[] = []", "try:", `  ${statement}`, "catch e:", '  print("caught")')));

    expect(caught("print(xs[0])").stderr).toContain(OUT_OF_RANGE);
    expect(caught("print(xs.pop())").stderr).toContain("cannot pop an empty array");
  });

  it("compiles the program rather than declining it", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src("xs: int[] = [1, 2]", "print(xs[-1])", ""),
    );

    expect(program.skipped).toEqual([]);
  });
});
