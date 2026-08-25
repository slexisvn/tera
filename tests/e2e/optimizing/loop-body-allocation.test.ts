import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/api/engine.js";
import { Optimizer } from "../../../src/optimizing/optimizer.js";
import { differential, src } from "../../helpers/tiers.js";
import { IR_NEW_OBJECT, type CFGFunction } from "../../../src/optimizing/ir/index.js";
import type { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";

function allocationsIn(source: string, name: string): number {
  const engine = new Engine({
    typecheck: "off",
    tieringPolicy: { jitThreshold: 5, baselineThreshold: 2 },
  });
  engine.run(source);
  const compiled = engine
    .collectFunctions()
    .find((fn: RegisterCompiledFunction) => fn.name === name && fn.feedbackVector !== null);
  expect(compiled).toBeDefined();
  const graph: CFGFunction = new Optimizer().compile(compiled!).graph;
  return graph.blocks
    .flatMap((block) => block.nodes)
    .filter((node) => node.type === IR_NEW_OBJECT).length;
}

const TEMPORARY = src(
  "fn run(n: int) -> int:",
  "  acc = 0",
  "  i = 0",
  "  while (i < n):",
  "    acc = (acc + { x: i, y: (i * 2) }.x)",
  "    i = (i + 1)",
  "  return acc",
  "run(300)",
);

const DEAD_LOCAL = src(
  "fn run(n: int) -> int:",
  "  acc = 0",
  "  i = 0",
  "  while (i < n):",
  "    point = { x: i, y: (i * 2) }",
  "    acc = (acc + point.x + point.y)",
  "    i = (i + 1)",
  "  return acc",
  "run(300)",
);

const CARRIED = src(
  "fn run(n: int) -> int:",
  "  point = { x: 0, y: 0 }",
  "  total = 0",
  "  i = 0",
  "  while (i < n):",
  "    total = (total + point.x)",
  "    point = { x: i, y: (i * 2) }",
  "    i = (i + 1)",
  "  return (total + point.y)",
  "run(300)",
);

describe("an object the loop body allocates every iteration", () => {
  it("drops the allocation when nothing carries it past the backedge", () => {
    expect(allocationsIn(TEMPORARY, "run")).toBe(0);
  });

  it("drops the allocation when the local it lands in is dead at every deopt point", () => {
    expect(allocationsIn(DEAD_LOCAL, "run")).toBe(0);
  });

  it("keeps the allocation the next iteration still reads", () => {
    expect(allocationsIn(CARRIED, "run")).toBeGreaterThan(0);
  });

  it("agrees with the interpreter once the allocation is gone", () => {
    expect(differential(TEMPORARY)).toEqual(44850);
    expect(differential(DEAD_LOCAL)).toEqual(134550);
  });

  it("agrees with the interpreter while the allocation stays", () => {
    expect(differential(CARRIED)).toEqual(45149);
  });

  it("agrees with the interpreter when two loop-body objects are folded away", () => {
    differential(src(
      "fn run(n):",
      "  acc = 0",
      "  i = 0",
      "  while i < n:",
      "    acc = acc + {x: i, y: i * 2}.y + {a: i + 1}.a",
      "    i = i + 1",
      "  return acc",
      "run(300)",
    ));
  });

  it("agrees with the interpreter when the loop deoptimizes after the fold", () => {
    differential(src(
      "fn run(n, flip):",
      "  acc = 0",
      "  i = 0",
      "  while i < n:",
      "    step = {x: i, y: i * 2}.x",
      "    if i == flip:",
      "      step = step + 0.5",
      "    acc = acc + step",
      "    i = i + 1",
      "  return acc",
      "run(300, 200)",
    ));
  });

  it("agrees with the interpreter when a loop-body object outlives its iteration", () => {
    differential(src(
      "fn run(n):",
      "  last = 0",
      "  keep = 0",
      "  i = 0",
      "  while i < n:",
      "    p = {x: i}",
      "    keep = last",
      "    last = p.x",
      "    i = i + 1",
      "  return keep + last",
      "run(300)",
    ));
  });
});
