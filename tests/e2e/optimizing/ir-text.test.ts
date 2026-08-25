import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/api/engine.js";
import { Optimizer } from "../../../src/optimizing/optimizer.js";
import { src } from "../../helpers/tiers.js";
import { GRAPH_FIELDS, parseIR, printIR } from "../../../src/optimizing/ir/text.js";
import type { CFGFunction } from "../../../src/optimizing/ir/index.js";
import type { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";

function optimizedGraphs(source: string): CFGFunction[] {
  const engine = new Engine({
    typecheck: "off",
    tieringPolicy: { jitThreshold: 5, baselineThreshold: 2 },
  });
  engine.run(source);
  const optimizer = new Optimizer();
  return engine
    .collectFunctions()
    .filter((fn: RegisterCompiledFunction) => fn.feedbackVector !== null)
    .map((fn: RegisterCompiledFunction) => optimizer.compile(fn).graph);
}

const NUMERIC = src(
  "fn work(n: int) -> int:",
  "  total = 0",
  "  i = 0",
  "  while (i < n):",
  "    total = (total + (i * 3))",
  "    i = (i + 1)",
  "  return total",
  "x = work(400)",
  "[x]",
);

const BRANCHING = src(
  "fn pick(n: int) -> int:",
  "  if (n > 10):",
  "    return (n * 2)",
  "  return (n - 1)",
  "fn drive(n: int) -> int:",
  "  last = 0",
  "  i = 0",
  "  while (i < n):",
  "    last = pick(i)",
  "    i = (i + 1)",
  "  return last",
  "x = drive(400)",
  "[x]",
);

const COROUTINE = src(
  "async fn produce(n):",
  "  return (n + 1)",
  "fn drive(n: int) -> int:",
  "  last = 0",
  "  i = 0",
  "  while (i < n):",
  "    last = i",
  "    i = (i + 1)",
  "  produce(last)",
  "  return last",
  "x = drive(400)",
  "[x]",
);

describe("the text form against graphs the optimizer really produced", () => {
  it("carries the function-level state a coroutine graph really has", () => {
    const asynchronous = optimizedGraphs(COROUTINE).filter((graph) => graph.isAsync);
    expect(asynchronous.length).toBeGreaterThan(0);
    for (const graph of asynchronous) {
      const text = printIR(graph);
      expect(text).toContain("isAsync=true");
      expect(parseIR(text).isAsync).toBe(true);
    }
  });

  for (const [label, source, unrepresentable] of [
    ["a counted loop", NUMERIC, []],
    ["a branching call", BRANCHING, ["RegisterCompiledFunction"]],
  ] as const) {
    it(`names every property of ${label} it cannot represent`, () => {
      const graphs = optimizedGraphs(source);
      expect(graphs.length).toBeGreaterThan(0);
      const opaque = new Set<string>();
      for (const graph of graphs) {
        for (const found of printIR(graph).matchAll(/<opaque:([A-Za-z0-9_]+)>/g)) {
          opaque.add(found[1]!);
        }
      }
      expect([...opaque].sort()).toEqual([...unrepresentable]);
    });

    it(`round-trips ${label} through parse and print`, () => {
      for (const graph of optimizedGraphs(source)) {
        const text = printIR(graph);
        expect({ name: graph.name, text: printIR(parseIR(text)) }).toMatchObject({ text });
      }
    });

    it(`keeps every function-level field of ${label}`, () => {
      for (const graph of optimizedGraphs(source)) {
        const reparsed = parseIR(printIR(graph));
        for (const field of GRAPH_FIELDS) {
          expect({ fn: graph.name, field, value: reparsed[field] }).toEqual({
            fn: graph.name,
            field,
            value: graph[field],
          });
        }
      }
    });

    it(`keeps every block and value of ${label}`, () => {
      for (const graph of optimizedGraphs(source)) {
        const reparsed = parseIR(printIR(graph));
        expect(reparsed.blocks.length).toBe(graph.blocks.length);
        expect(reparsed.parameters.length).toBe(graph.parameters.length);
        expect(reparsed.blocks.map((block) => block.nodes.length)).toEqual(
          graph.blocks.map((block) => block.nodes.length),
        );
      }
    });
  }
});
