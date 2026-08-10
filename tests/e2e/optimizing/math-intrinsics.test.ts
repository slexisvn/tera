import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/api/engine.js";
import { Optimizer } from "../../../src/optimizing/optimizer.js";
import { compileModule } from "../../../src/optimizing/drivers/aot.js";
import { cBackend } from "../../../src/optimizing/backends/c/backend.js";
import { moduleFromGraphs } from "../../../src/optimizing/compilation-unit.js";
import { differential, src, type Tier } from "../../helpers/tiers.js";
import {
  IR_CALL_BUILTIN,
  IR_GENERIC_CALL,
  type CFGFunction,
} from "../../../src/optimizing/ir/index.js";
import type { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";

const jitTiers: Tier[] = ["baseline", "jit", "osr"];

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

const hotMath = (expression: string) =>
  src(
    "fn run(n: int) -> float:",
    "  acc = 0.0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    `    acc = ${expression}`,
    "  return acc",
    "x = run(1200)",
    "[x]",
  );

describe("Math intrinsics lower in the middle end", () => {
  it("replaces a Math call with a single builtin call before any backend runs", () => {
    const graph = graphOf(hotMath("Math.sqrt((i * 1.0))"), "run");
    const opcodes = opcodesOf(graph);

    expect(opcodes).toContain(IR_CALL_BUILTIN);
    expect(opcodes).not.toContain(IR_GENERIC_CALL);
  });

  it("names the lowered call after the shared registry entry", () => {
    const graph = graphOf(hotMath("Math.abs((i * 1.0) - 600.0)"), "run");
    const call = graph.blocks
      .flatMap((block) => block.nodes)
      .find((node) => node.type === IR_CALL_BUILTIN);

    expect(call?.props.name).toBe("Math.abs");
  });

  it("leaves a Math call with the wrong argument count generic", () => {
    const graph = graphOf(hotMath("Math.sqrt((i * 1.0), 2.0)"), "run");

    expect(opcodesOf(graph)).not.toContain(IR_CALL_BUILTIN);
  });

  it("agrees across tiers for unary Math intrinsics", () => {
    differential(hotMath("(acc + Math.sqrt(Math.abs((i * 1.0) - 600.0)))"), {
      tiers: jitTiers,
    });
  }, 30000);

  it("agrees across tiers for binary Math intrinsics", () => {
    differential(hotMath("(acc + Math.min(Math.max((i * 1.0), 100.0), 900.0))"), {
      tiers: jitTiers,
    });
  }, 30000);

  it("agrees across tiers for floor, ceil and trunc", () => {
    differential(
      hotMath("(acc + Math.floor((i * 0.5)) + Math.ceil((i * 0.25)) + Math.trunc((i * 0.75)))"),
      { tiers: jitTiers },
    );
  }, 30000);

  it("keeps Math.round on JS half-up semantics at every tier", () => {
    expect(
      differential(
        src(
          "fn r(x: float) -> float:",
          "  return Math.round(x)",
          "fn run(n: int) -> float:",
          "  acc = 0.0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    acc = r(2.5)",
          "  return acc",
          "warm = run(1200)",
          "[warm, r(0.5), r(1.5), r(2.5), r(3.5), r(-1.5), r(-2.5)]",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([3, 1, 2, 3, 4, -1, -2]);
  }, 30000);

  it("emits a C helper for the same lowered call so AOT benefits too", () => {
    const graph = graphOf(
      src(
        "fn dist(a: float, b: float) -> float:",
        "  return Math.sqrt((a - b))",
        "dist(9.0, 4.0)",
        "dist(8.0, 2.0)",
        "dist(7.0, 1.0)",
      ),
      "dist",
    );
    const program = compileModule(moduleFromGraphs([graph]), cBackend);

    expect(program.skipped).toEqual([]);
    expect(program.source).toContain("tera_math_sqrt");
  });
});
