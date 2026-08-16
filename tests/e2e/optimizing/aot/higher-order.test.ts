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

const APPLY = src("fn apply(f: (int) -> int, x: int) -> int:", "  return f(x)");

describe("AOT higher-order functions", () => {
  itNative("calls the callback it was handed", () => {
    matchesInterpreter(
      src(APPLY, "fn f(n: int) -> int:", "  return apply(v => v * 2, n)"),
      "f",
      [5],
    );
  });

  itNative("keeps two callbacks apart at two call sites", () => {
    matchesInterpreter(
      src(
        APPLY,
        "fn f(n: int) -> int:",
        "  return apply(v => v * 2, n) * 100 + apply(v => v + 1, n)",
      ),
      "f",
      [5],
    );
  });

  itNative("shares one copy when the same callback is handed over twice", () => {
    matchesInterpreter(
      src(APPLY, "fn f(n: int) -> int:", "  return apply(v => v * 3, n) + apply(v => v * 3, n)"),
      "f",
      [4],
    );
  });

  itNative("takes a named function as a value", () => {
    matchesInterpreter(
      src(
        "fn double(v: int) -> int:",
        "  return v * 2",
        APPLY,
        "fn f(n: int) -> int:",
        "  return apply(double, n)",
      ),
      "f",
      [7],
    );
  });

  itNative("takes two callbacks in one call", () => {
    matchesInterpreter(
      src(
        "fn combine(f: (int) -> int, g: (int) -> int, x: int) -> int:",
        "  return f(x) + g(x)",
        "fn f(n: int) -> int:",
        "  return combine(v => v * 2, v => v + 1, n)",
      ),
      "f",
      [5],
    );
  });

  itNative("calls the callback inside a loop", () => {
    matchesInterpreter(
      src(
        "fn total(f: (int) -> int, n: int) -> int:",
        "  s: int = 0",
        "  i: int = 0",
        "  while i < n:",
        "    s += f(i)",
        "    i += 1",
        "  return s",
        "fn f(n: int) -> int:",
        "  return total(v => v * v, n) * 100 + total(v => v + 1, n)",
      ),
      "f",
      [5],
    );
  });

  itNative("calls the callback twice over", () => {
    matchesInterpreter(
      src(
        "fn twice(f: (int) -> int, x: int) -> int:",
        "  return f(f(x))",
        "fn f(n: int) -> int:",
        "  return twice(v => v + 3, n)",
      ),
      "f",
      [1],
    );
  });

  itNative("gives an untyped callback the types of the parameter it fills", () => {
    matchesInterpreter(
      src(
        "fn apply(f: (string) -> string, s: string) -> string:",
        "  return f(s)",
        "fn f(n: int) -> int:",
        '  if apply(v => v + "!", "hi") == "hi!":',
        "    return n",
        "  return 0",
      ),
      "f",
      [7],
    );
  });

  itNative("passes a float callback", () => {
    matchesInterpreter(
      src(
        "fn apply(f: (float) -> float, x: float) -> float:",
        "  return f(x)",
        "fn f(n: int) -> int:",
        "  return apply(v => v / 2.0, 9.0) + apply(v => v + 0.5, 1.0) + n",
      ),
      "f",
      [0],
    );
  });

  it("declines a callback the compiler cannot pin down", () => {
    expect(
      declined(
        src(
          APPLY,
          "fn f(n: int) -> int:",
          "  fs = [v => v * 2, v => v + 1]",
          "  return apply(fs[n], 3)",
        ),
      ),
    ).toContain("unsupported generic call");
  });

  it("declines a callback used at two different written types", () => {
    expect(
      declined(
        src(
          "fn ints(f: (int) -> int, x: int) -> int:",
          "  return f(x)",
          "fn floats(f: (float) -> float, x: float) -> float:",
          "  return f(x)",
          "fn shared(v: int) -> int:",
          "  return v",
          "fn f(n: int) -> int:",
          "  return ints(shared, n) + floats(shared, 1.0)",
        ),
      ),
    ).not.toBe("");
  });
});
