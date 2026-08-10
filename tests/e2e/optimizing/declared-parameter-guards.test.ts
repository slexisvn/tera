import { describe, expect, it } from "vitest";
import { differential, src, type Tier } from "../../helpers/tiers.js";
import { Engine } from "../../../src/api/engine.js";
import { Optimizer } from "../../../src/optimizing/optimizer.js";
import {
  IR_CHECK_PRIMITIVE,
  IR_CHECK_SMI,
  type CFGFunction,
} from "../../../src/optimizing/ir/index.js";
import type { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";

function graphOf(source: string, name: string): CFGFunction {
  const engine = new Engine({
    typecheck: "off",
    tieringPolicy: { jitThreshold: 5, baselineThreshold: 2 },
  });
  engine.run(source);
  const compiledFn = engine
    .collectFunctions()
    .find((fn: RegisterCompiledFunction) => fn.name === name);
  return new Optimizer().compile(compiledFn!).graph;
}

function opcodesOf(graph: CFGFunction): string[] {
  return graph.blocks.flatMap((block) => block.nodes.map((node) => node.type));
}

const jitTiers: Tier[] = ["baseline", "jit", "osr"];

const warmedThenViolated = (
  declaration: readonly string[],
  warmCall: string,
  violatingCall: string,
) =>
  src(
    ...declaration,
    "fn run(n: int) -> int:",
    "  last = 0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    `    last = ${warmCall}`,
    "  return last",
    "warm = run(1200)",
    `violated = ${violatingCall}`,
    "[warm, violated]",
  );

describe("declared parameter types are guarded in the optimizing tier", () => {

  it("guards a declared string parameter at function entry", () => {
    const graph = graphOf(
      src(
        "fn first(s: string) -> int:",
        "  return s.char_code_at(0)",
        'first("Hi")',
        'first("Ho")',
        'first("He")',
      ),
      "first",
    );

    expect(opcodesOf(graph)).toContain(IR_CHECK_PRIMITIVE);
  });

  it("adds no guard for an undeclared parameter", () => {
    const graph = graphOf(
      src("fn twice(x):", "  return (x + x)", "twice(3)", "twice(4)", "twice(5)"),
      "twice",
    );

    expect(opcodesOf(graph)).not.toContain(IR_CHECK_PRIMITIVE);
  });
  it("deoptimizes cleanly when a declared int parameter receives a double", () => {
    expect(
      differential(
        warmedThenViolated(
          ["fn twice(x: int) -> int:", "  return (x + x)"],
          "twice(3)",
          "twice(2.5)",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([6, 5]);
  }, 30000);

  it("deoptimizes cleanly when a declared string parameter receives a number", () => {
    expect(
      differential(
        warmedThenViolated(
          ["fn first(s: string) -> int:", "  return s.char_code_at(0)"],
          'first("Hi")',
          'first("Zz")',
        ),
        { tiers: jitTiers },
      ),
    ).toEqual(["H".charCodeAt(0), "Z".charCodeAt(0)]);
  }, 30000);

  it("keeps a declared float parameter correct when handed an integer", () => {
    expect(
      differential(
        warmedThenViolated(
          ["fn half(x: float) -> float:", "  return (x / 2.0)"],
          "half(9.0)",
          "half(7)",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([4.5, 3.5]);
  }, 30000);

  it("keeps a declared bool parameter correct across tiers", () => {
    expect(
      differential(
        warmedThenViolated(
          ["fn flip(b: bool) -> bool:", "  return (!b)"],
          "flip(true)",
          "flip(false)",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([false, true]);
  }, 30000);
});
