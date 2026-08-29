import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/api/engine.js";
import { src } from "../../helpers/tiers.js";
import type { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";

const HOT_ITERATIONS = 1200;

const NEVER_OPTIMIZES = { jitThreshold: 1e12, baselineThreshold: 1e12 };
const OPTIMIZES_EARLY = { jitThreshold: 30, baselineThreshold: 3 };

const hot = (declaration: string, call: string) =>
  src(
    declaration,
    "",
    "fn run(n: int) -> float:",
    "  last = 0.0",
    "  i = 0",
    "  while (i < n):",
    `    last = ${call}`,
    "    i = (i + 1)",
    "  return last",
    "",
    `print(run(${HOT_ITERATIONS}))`,
  );

const printing = hot(
  src("fn shout(i: int) -> float:", "  print(i)", "  return 0.0"),
  "shout(i)",
);

const parsing = hot(
  src("fn parsed(s: string) -> float:", "  return parse_float(s)"),
  'parsed("1.5")',
);

interface Run {
  readonly printed: string[];
  readonly optimized: string[];
}

function runAt(source: string, tieringPolicy: object): Run {
  const printed: string[] = [];
  const compiled: RegisterCompiledFunction[] = [];
  const engine = new Engine({
    typecheck: "off",
    tieringPolicy,
    onCompile: (fn) => void compiled.push(fn),
    output: (text: unknown) => void printed.push(String(text)),
  });
  engine.run(source);
  return {
    printed,
    optimized: compiled.filter((fn) => fn.optimizedCode).map((fn) => fn.name ?? ""),
  };
}

function differentialOn(source: string, hotFunction: string): Run {
  const interpreted = runAt(source, NEVER_OPTIMIZES);
  const optimized = runAt(source, OPTIMIZES_EARLY);

  expect(interpreted.optimized).toEqual([]);
  expect(optimized.optimized).toContain(hotFunction);
  expect(optimized.printed).toEqual(interpreted.printed);
  return interpreted;
}

describe("global builtins called from optimized code", () => {
  it("prints every line the interpreter prints", () => {
    const interpreted = differentialOn(printing, "shout");

    expect(interpreted.printed).toHaveLength(HOT_ITERATIONS + 1);
  });

  it("answers what the builtin answers in the interpreter", () => {
    const interpreted = differentialOn(parsing, "parsed");

    expect(interpreted.printed).toEqual(["1.5"]);
  });
});
