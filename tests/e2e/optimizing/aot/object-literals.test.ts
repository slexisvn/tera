import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string) {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`);
  expect(program.skipped).toEqual([]);
  return program;
}

function declined(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`);
  return program.skipped.map((entry) => entry.reason).join("; ");
}

function matchesInterpreter(source: string, entry: string, args: readonly number[]): void {
  const program = compile(source);
  const interpreted = nodeEngine({ typecheck: "off" }).runNative(
    `${source}\n${entry}(${args.join(", ")})\n`,
  );
  expect(runCFunction(cSource(program), entry, args)).toBe(interpreted);
}

describe("AOT object literals", () => {
  itNative("reads back a field it wrote", () => {
    matchesInterpreter(
      src("fn f(n: int) -> int:", "  o = { a: n, b: 2 }", "  return o.a + o.b"),
      "f",
      [5],
    );
  });

  itNative("carries a literal out of the function that built it", () => {
    matchesInterpreter(
      src(
        "fn make(n: int):",
        "  return { a: n, b: n * 2 }",
        "fn f(n: int) -> int:",
        "  o = make(n)",
        "  return o.a + o.b",
      ),
      "f",
      [4],
    );
  });

  itNative("reassigns a field after the literal is built", () => {
    matchesInterpreter(
      src("fn f(n: int) -> int:", "  o = { a: 1 }", "  o.a = n", "  return o.a"),
      "f",
      [9],
    );
  });

  itNative("mixes a float and an int field", () => {
    matchesInterpreter(
      src(
        "fn f(n: int) -> int:",
        "  o = { count: n, rate: 1.5 }",
        "  return o.count + (o.rate * 2.0)",
      ),
      "f",
      [3],
    );
  });

  itNative("builds two literals of the same layout in different functions", () => {
    matchesInterpreter(
      src(
        "fn one(n: int) -> int:",
        "  return { a: n, b: 1 }.a",
        "fn two(n: int) -> int:",
        "  return { a: n, b: 2 }.b",
        "fn f(n: int) -> int:",
        "  return one(n) + two(n)",
      ),
      "f",
      [6],
    );
  });

  it("declines a literal whose field holds something with no machine type", () => {
    expect(declined(src("fn f() -> int:", "  o = { a: v => v }", "  return 1"))).not.toBe("");
  });
});

describe("AOT string comparison", () => {
  itNative("branches on equality", () => {
    matchesInterpreter(
      src(
        "fn price(name: string) -> int:",
        '  if name == "apple":',
        "    return 1",
        "  return 2",
        "fn f(n: int) -> int:",
        '  return price("apple") + price("pear") + n',
      ),
      "f",
      [0],
    );
  });

  itNative("orders two strings lexicographically", () => {
    matchesInterpreter(
      src(
        "fn f(n: int) -> int:",
        "  total = n",
        '  if "ant" < "bee":',
        "    total = total + 1",
        '  if "zebra" <= "apple":',
        "    total = total + 10",
        '  if "same" >= "same":',
        "    total = total + 100",
        '  if "a" != "b":',
        "    total = total + 1000",
        "  return total",
      ),
      "f",
      [0],
    );
  });

  itNative("compares a built string against a spelled-out one", () => {
    matchesInterpreter(
      src(
        "fn f(n: int) -> int:",
        "  built = n.to_string()",
        '  if built == "7":',
        "    return 1",
        "  return 0",
      ),
      "f",
      [7],
    );
  });
});

describe("AOT arrays of spelled-out strings", () => {
  itNative("indexes an array of string constants", () => {
    matchesInterpreter(
      src(
        "fn pick(i: int) -> string:",
        '  names = ["ant", "bee", "cow"]',
        "  return names[i]",
        "fn f(i: int) -> int:",
        '  if pick(i) == "cow":',
        "    return 1",
        "  return 0",
      ),
      "f",
      [2],
    );
  });

  itNative("keeps a string the program builds into an array", () => {
    matchesInterpreter(
      src(
        "fn f(i: int) -> int:",
        '  names = ["H", "O"]',
        '  names[i] = "N" + "!"',
        '  if names[i] == "N!":',
        "    return 1",
        "  return 0",
      ),
      "f",
      [1],
    );
  });

  itNative("reads a field a constant key names", () => {
    matchesInterpreter(
      src("fn f(n: int) -> int:", "  o = { a: n, b: 2 }", "  return o[\"a\"] + o[\"b\"]"),
      "f",
      [5],
    );
  });

  itNative("writes a field a constant key names", () => {
    matchesInterpreter(
      src("fn f(n: int) -> int:", "  o = { a: 1 }", "  o[\"a\"] = n", "  return o.a"),
      "f",
      [9],
    );
  });

  itNative("answers membership from the shape the literal has", () => {
    matchesInterpreter(
      src(
        "fn f(n: int) -> int:",
        "  o = { a: n }",
        "  present = \"a\" in o",
        "  missing = \"z\" in o",
        "  if present and not missing:",
        "    return n",
        "  return 0",
      ),
      "f",
      [3],
    );
  });
  itNative("counts the keys a literal declares", () => {
    matchesInterpreter(
      src("fn f(n: int) -> int:", "  o = { a: n, b: 2, c: 3 }", "  return Object.keys(o).length"),
      "f",
      [1],
    );
  });

  itNative("folds the values a literal holds", () => {
    matchesInterpreter(
      src(
        "fn add(a: int, b: int) -> int:",
        "  return a + b",
        "fn f(n: int) -> int:",
        "  o = { a: n, b: 2, c: 3 }",
        "  return Object.values(o).reduce(add, 0)",
      ),
      "f",
      [4],
    );
  });
});
