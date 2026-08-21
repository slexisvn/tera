import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
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

function declines(source: string): void {
  expect(() =>
    nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
      backend: "x64-windows",
      format: "executable",
    }),
  ).toThrow(/cannot emit/);
}

describe("AOT generators", () => {
  itRunsPe("walks a counting generator with for-of", () => {
    agrees(
      src(
        "fn* counter(limit: int):",
        "  i: int = 0",
        "  while i < limit:",
        "    yield i",
        "    i += 1",
        "for n of counter(5):",
        "  print(n)",
      ),
    );
  });

  itRunsPe("yields strings", () => {
    agrees(
      src(
        "fn* words():",
        '  yield "alpha"',
        '  yield "beta"',
        "for w of words():",
        "  print(w)",
      ),
    );
  });

  itRunsPe("steps a generator by hand", () => {
    agrees(
      src(
        "fn* pair():",
        "  yield 1",
        "  yield 2",
        "it = pair()",
        "a = it.next().value",
        "b = it.next().value",
        "print(a + b)",
      ),
    );
  });

  itRunsPe("stops when next reports it is done", () => {
    agrees(
      src(
        "fn* three():",
        "  yield 7",
        "  yield 8",
        "  yield 9",
        "it = three()",
        "r = it.next()",
        "while not r.done:",
        "  print(r.value)",
        "  r = it.next()",
        'print("end")',
      ),
    );
  });

  itRunsPe("carries locals across a yield", () => {
    agrees(
      src(
        "fn* fib(n: int):",
        "  a: int = 0",
        "  b: int = 1",
        "  i: int = 0",
        "  while i < n:",
        "    yield a",
        "    t: int = a + b",
        "    a = b",
        "    b = t",
        "    i += 1",
        "total: int = 0",
        "for v of fib(10):",
        "  total += v",
        "print(total)",
      ),
    );
  });

  itRunsPe("resumes where an interrupted walk left off", () => {
    agrees(
      src(
        "fn* two():",
        "  yield 1",
        "  yield 2",
        "g = two()",
        "for a of g:",
        "  print(a)",
        "  break",
        "for b of g:",
        "  print(b)",
      ),
    );
  });

  itRunsPe("returns early without yielding", () => {
    agrees(
      src(
        "fn* early(n: int):",
        "  if n < 0:",
        "    return",
        "  yield n",
        "  yield n + 1",
        "for v of early(5):",
        "  print(v)",
        "for v of early(-1):",
        "  print(v)",
        'print("done")',
      ),
    );
  });

  itRunsPe("delegates to another generator", () => {
    agrees(
      src(
        "fn* inner():",
        "  yield 1",
        "  yield 2",
        "fn* outer():",
        "  yield 0",
        "  yield* inner()",
        "  yield 3",
        "for v of outer():",
        "  print(v)",
      ),
    );
  });

  itRunsPe("yields a field of an object it built", () => {
    agrees(
      src(
        "class Point:",
        "  public x: int",
        "  public y: int",
        "  public constructor(x: int, y: int):",
        "    this.x = x",
        "    this.y = y",
        "fn* points(n: int):",
        "  i: int = 0",
        "  while i < n:",
        "    p = Point(i, i * 2)",
        "    yield p.x + p.y",
        "    i += 1",
        "for v of points(4):",
        "  print(v)",
      ),
    );
  });

  itRunsPe("walks a generator from inside a function", () => {
    agrees(
      src(
        "fn* take(n: int):",
        "  i: int = 0",
        "  while i < n:",
        "    yield i",
        "    i += 1",
        "fn sum(n: int) -> int:",
        "  total: int = 0",
        "  for v of take(n):",
        "    total += v",
        "  return total",
        "print(sum(3), sum(5), sum(0))",
      ),
    );
  });

  itRunsPe("yields from a nested loop", () => {
    agrees(
      src(
        "fn* nested(n: int):",
        "  i: int = 0",
        "  while i < n:",
        "    j: int = 0",
        "    while j < 2:",
        "      yield i * 10 + j",
        "      j += 1",
        "    i += 1",
        "for v of nested(3):",
        "  print(v)",
      ),
    );
  });

  itRunsPe("feeds what it yields into a map", () => {
    agrees(
      src(
        "fn* keyed():",
        '  yield "a"',
        '  yield "b"',
        "counts = Map()",
        "for k of keyed():",
        "  counts.set(k, (counts.get(k) ?? 0) + 1)",
        'print(counts.size, counts.get("a"))',
      ),
    );
  });

  itRunsPe("steps a generator in a program that also catches a throw", () => {
    agrees(
      src(
        "try:",
        '  throw "cow"',
        "catch e:",
        "  print(e.to_upper_case())",
        "fn* pairs():",
        "  yield 1",
        "  yield 2",
        "it = pairs()",
        "r = it.next()",
        "while not r.done:",
        "  print(r.value)",
        "  r = it.next()",
      ),
    );
  });

  itRunsPe("delegates inside a program that also catches a throw", () => {
    agrees(
      src(
        "fn* inner(n: int):",
        "  i: int = 0",
        "  while i < n:",
        "    yield i",
        "    i += 1",
        "fn* outer(n: int):",
        "  yield -1",
        "  yield* inner(n)",
        "  yield 99",
        "for v of outer(2):",
        "  print(v)",
        "try:",
        '  throw Error("boom")',
        "catch e:",
        "  print(e.message)",
      ),
    );
  });

  it("declines a generator that throws while it is generating", () => {
    declines(
      src(
        "fn* counted(n: int):",
        "  i: int = 0",
        "  while i < n:",
        "    if i == 2:",
        '      throw "stop"',
        "    yield i",
        "    i += 1",
        "try:",
        "  for v of counted(5):",
        "    print(v)",
        "catch e:",
        '  print("caught", e)',
      ),
    );
  });

  it("declines a generator that is printed rather than walked", () => {
    declines(src("fn* one():", "  yield 5", "print(one())"));
  });

  it("declines a generator that yields two different types", () => {
    declines(src("fn* mixed():", "  yield 1", '  yield "two"', "for v of mixed():", "  print(v)"));
  });
});
