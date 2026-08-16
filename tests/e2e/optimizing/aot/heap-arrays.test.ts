import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

function compile(lines: readonly string[]) {
  const program = nodeEngine().compileAot(`${lines.join("\n")}\n`, { wholeProgram: true });
  expect(program.skipped).toEqual([]);
  return program;
}

function prints(lines: readonly string[], expected: string): void {
  expect(runCProgram(cSource(compile(lines))).stdout).toBe(expected);
}

const TOTAL = [
  "fn total(xs: int[]) -> int:",
  "  s = 0",
  "  for x of xs:",
  "    s = s + x",
  "  return s",
];

describe("AOT arrays that outlive the frame", () => {
  itNative("passes an array to a function that walks it", () => {
    prints([...TOTAL, "print(total([3, 1, 4, 1, 5]))"], "14\n");
  });

  itNative("reads the length of an array it was handed", () => {
    prints(
      ["fn size(xs: int[]) -> int:", "  return xs.length", "print(size([7, 8, 9]))"],
      "3\n",
    );
  });

  itNative("indexes an array it was handed", () => {
    prints(
      [
        "fn second(xs: float[]) -> float:",
        "  return xs[1]",
        "print(second([1.5, 2.5, 3.5]))",
      ],
      "2.5\n",
    );
  });

  itNative("returns an array the caller then walks", () => {
    prints(
      [...TOTAL, "fn make(n: int) -> int[]:", "  return [n, n * 2, n * 3]", "print(total(make(4)))"],
      "24\n",
    );
  });

  itNative("keeps an array in a field across calls", () => {
    prints(
      [
        "class Bag:",
        "  private items: int[] = [1, 2, 3, 4]",
        "  public sum() -> int:",
        "    s = 0",
        "    for x of this.items:",
        "      s = s + x",
        "    return s",
        "  public put(i: int, v: int) -> int:",
        "    this.items[i] = v",
        "    return this.items[i]",
        "b = Bag()",
        "print(b.sum())",
        "print(b.put(0, 10))",
        "print(b.sum())",
      ],
      "10\n10\n19\n",
    );
  });

  itNative("writes through an array the callee received", () => {
    prints(
      [
        "fn fill(xs: int[], v: int) -> int:",
        "  i = 0",
        "  while i < xs.length:",
        "    xs[i] = v",
        "    i = i + 1",
        "  return xs[0] + xs[2]",
        "print(fill([0, 0, 0], 7))",
      ],
      "14\n",
    );
  });

  itNative("widens an integer literal array a float is stored into", () => {
    prints(
      [
        "fn f(n: int) -> float:",
        "  a = [0, 0]",
        "  a[0] = a[0] + 0.5",
        "  return a[0] * n",
        "print(f(4))",
      ],
      "2\n",
    );
  });

  it("allocates the array on the heap rather than in the frame", () => {
    const program = compile([...TOTAL, "print(total([1, 2]))"]);

    expect(cSource(program)).toContain("tera_alloc(");
    expect(cSource(program)).not.toMatch(/int32_t v\d+\[\d+\] = \{/);
  });

  itNative("indexes an array of text the program spelled out", () => {
    prints(
      [
        "fn f(i: int) -> string:",
        '  names = ["H", "O"]',
        "  return names[i]",
        "print(f(1))",
      ],
      "O\n",
    );
  });

  itNative("dispatches per element over an array it built itself", () => {
    prints(
      [
        "class Shape:",
        "  public constructor(n: int):",
        "    this.n = n",
        "  public area() -> int:",
        "    return this.n",
        "class Circle extends Shape:",
        "  public constructor(r: int):",
        "    super(r)",
        "  public area() -> int:",
        "    return this.n * 2",
        "fn total() -> int:",
        "  xs = [Shape(3), Circle(4)]",
        "  return xs[0].area() + xs[1].area()",
        "print(total())",
      ],
      "11\n",
    );
  });

  itNative("hands an array of instances on to another function", () => {
    prints(
      [
        "class Shape:",
        "  public constructor(n: int):",
        "    this.n = n",
        "fn size(xs: Shape[]) -> int:",
        "  return xs.length",
        "print(size([Shape(3), Shape(4), Shape(5)]))",
      ],
      "3\n",
    );
  });
});
