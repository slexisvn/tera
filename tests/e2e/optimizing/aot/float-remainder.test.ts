import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const compiled = (source: string) =>
  nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend: "c" });

const PAIRS = [
  ["7.0", "2.0"],
  ["(0.0 - 7.0)", "2.0"],
  ["7.5", "2.5"],
  ["7.5", "(0.0 - 2.5)"],
  ["0.0", "3.0"],
  ["1.0", "3.0"],
  ["1e16", "7.0"],
  ["1e-8", "3e-9"],
  ["3.0", "3.0"],
  ["1e300", "7.0"],
  ["5.0", "0.0"],
  ["(1.0 / 0.0)", "3.0"],
  ["3.0", "(1.0 / 0.0)"],
] as const;

describe("a remainder over numbers that are not whole", () => {
  itRunsPe("answers what the interpreter answers for every shape of operand", () => {
    peAgrees(
      src(...PAIRS.map(([left, right]) => `print(${left} % ${right})`)),
    );
  });

  itRunsPe("takes a remainder of values only the running program knows", () => {
    peAgrees(
      src(
        "fn show(a: float, b: float):",
        '  print(a, "%", b, "=", a % b)',
        "vals: float[] = [7.0, 7.5, 0.0, 1e16]",
        "divs: float[] = [2.0, 2.5, 3.0, 7.0]",
        "i = 0",
        "while i < vals.length:",
        "  show(vals[i], divs[i])",
        "  i += 1",
      ),
    );
  });

  itRunsPe("takes a remainder written as an assignment the same way", () => {
    peAgrees(
      src(
        "x: float = 7.5",
        "x %= 2.0",
        "print(x)",
        "y: float = 20.0",
        "for d of [7.0, 3.5]:",
        "  y %= d",
        "  print(y)",
      ),
    );
  });

  it("carries the helper for a program whose only remainder is an assignment", () => {
    const program = compiled(src("x: float = 7.5", "x %= 2.0", "print(x)"));

    expect(program.compiled.map((fn) => fn.name)).toContain("_float_mod");
  });

  itRunsPe("counts a collatz walk that halves with Math.floor", () => {
    peAgrees(
      src(
        "fn collatz(n: int) -> int:",
        "  steps = 0",
        "  v = n",
        "  while v != 1:",
        "    if v % 2 == 0:",
        "      v = Math.floor(v / 2)",
        "    else:",
        "      v = 3 * v + 1",
        "    steps += 1",
        "  return steps",
        "for n of [7, 27, 97]:",
        "  print(n, collatz(n))",
      ),
    );
  });

  it("carries no remainder helper into a program whose remainders are whole", () => {
    const program = compiled(src("fn f(n: int) -> int:", "  return n % 3", "print(f(10))"));

    expect(program.compiled.map((fn) => fn.name)).not.toContain("_float_mod");
  });

  it("carries the helper only once for a program that needs it", () => {
    const program = compiled(src("print(7.5 % 2.0)", "print(9.5 % 4.0)"));
    const helpers = program.compiled.filter((fn) => fn.name === "_float_mod");

    expect(helpers).toHaveLength(1);
  });
});
