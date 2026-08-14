import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irInt32Add,
  irReturn,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";
import {
  cfgPassTracer,
  middleEndPhases,
  middleEndPipeline,
  runMiddleEnd,
} from "../../src/optimizing/pipeline.js";
import {
  AnalysisManager,
  AnalysisRegistry,
  analysisId,
  type AnalysisPass,
} from "../../src/optimizing/infra/analysis-manager.js";
import { PassManager } from "../../src/optimizing/infra/pass-manager.js";
import { compilerOptions } from "../../src/optimizing/options.js";

beforeEach(() => resetIRNodeIds());

function passNamed(name: string) {
  const pass = middleEndPipeline({ feedback: undefined }).find(
    (candidate) => candidate.name === name,
  );
  if (!pass) throw new Error(`missing pass ${name}`);
  return pass;
}

function foldedGraph(): CFGFunction {
  const graph = new CFGFunction("folded");
  const block = graph.addBlock();
  const left = irConstant(20);
  const right = irConstant(22);
  const sum = irInt32Add(left, right);
  block.addNode(left);
  block.addNode(right);
  block.addNode(sum);
  block.addNode(irReturn(sum));
  return graph;
}

function stableGraph(): CFGFunction {
  const graph = new CFGFunction("stable");
  const param = graph.addParameter(0);
  const block = graph.addBlock();
  block.addNode(irReturn(param));
  return graph;
}

function managerFor(graph: CFGFunction) {
  let runs = 0;
  const id = analysisId<number>("node-count");
  const pass: AnalysisPass<CFGFunction, number> = {
    id,
    run: (g) => {
      runs++;
      return g.blocks.reduce((sum, block) => sum + block.nodes.length, 0);
    },
  };
  const registry = new AnalysisRegistry<CFGFunction>();
  registry.register(pass);
  const manager = new AnalysisManager(graph, registry);
  return { id, manager, runs: () => runs };
}

describe("middleEndPipeline pass reporting", () => {
  it("invalidates analyses when a real pass mutates the graph", () => {
    const graph = foldedGraph();
    const analysis = managerFor(graph);
    const passes = new PassManager(analysis.manager, compilerOptions());

    expect(analysis.manager.get(analysis.id)).toBe(4);
    expect(passes.run(graph, [passNamed("sccp")])).toBe(true);
    expect(analysis.manager.get(analysis.id)).toBe(4);
    expect(analysis.runs()).toBe(2);
  });

  it("keeps analyses cached when a real pass makes no change", () => {
    const graph = stableGraph();
    const analysis = managerFor(graph);
    const passes = new PassManager(analysis.manager, compilerOptions());

    expect(analysis.manager.get(analysis.id)).toBe(1);
    expect(passes.run(graph, [passNamed("sccp")])).toBe(false);
    expect(analysis.manager.get(analysis.id)).toBe(1);
    expect(analysis.runs()).toBe(1);
  });
});

function captureConsole(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("printAfterAll pass tracing", () => {
  it("builds no tracer while the option is off", () => {
    expect(cfgPassTracer(compilerOptions("speed"))).toBeNull();
  });

  it("builds a tracer once the option is on", () => {
    expect(cfgPassTracer(compilerOptions("speed", { printAfterAll: true }))).not.toBeNull();
  });

  it("prints exactly one section per middle-end pass", () => {
    const options = compilerOptions("speed", { printAfterAll: true });
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), options));

    expect(sections).toHaveLength(middleEndPipeline(options).length);
    expect(sections.every((section) => section.startsWith("*** IR after #"))).toBe(true);
  });

  it("attributes each change and invalidation to the pass that caused it", () => {
    const options = compilerOptions("speed", { printAfterAll: true });
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), options));
    const headerOf = (name: string) =>
      sections.find((section) => section.includes(` ${name} [`))?.split("\n")[0];

    expect(headerOf("sccp")).toContain(
      "sccp [changed, nodes 4 -> 4 (+0), invalidated type-inference dominance loops points-to mod-ref] ***",
    );
    expect(headerOf("dead-code-elimination-after-late-escape")).toContain(
      "dead-code-elimination-after-late-escape [changed, nodes 4 -> 2 (-2), invalidated points-to mod-ref] ***",
    );
    expect(headerOf("gvn")).toContain("[unchanged, nodes 4 -> 4 (+0), invalidated nothing]");
  });

  it("dumps the graph body under every section header", () => {
    const options = compilerOptions("speed", { printAfterAll: true });
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), options));
    const folded = sections.find((section) => section.includes(" sccp ["));

    expect(folded).toContain("=== CFG Function: folded ===");
    expect(folded).toContain("Constant() [value=42]");
  });

  it("stays silent while the option is off", () => {
    const sections = captureConsole(() => runMiddleEnd(foldedGraph(), compilerOptions("speed")));

    expect(sections).toEqual([]);
  });
});
