import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irInt32Add,
  irReturn,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";
import { middleEndPipeline } from "../../src/optimizing/pipeline.js";
import { findLoops } from "../../src/optimizing/passes/loop-opts.js";
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
  const pass = middleEndPipeline({ feedback: undefined, findLoops }).find(
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
    expect(passes.run(graph, [passNamed("const-fold-early")])).toBe(true);
    expect(analysis.manager.get(analysis.id)).toBe(4);
    expect(analysis.runs()).toBe(2);
  });

  it("keeps analyses cached when a real pass makes no change", () => {
    const graph = stableGraph();
    const analysis = managerFor(graph);
    const passes = new PassManager(analysis.manager, compilerOptions());

    expect(analysis.manager.get(analysis.id)).toBe(1);
    expect(passes.run(graph, [passNamed("const-fold-early")])).toBe(false);
    expect(analysis.manager.get(analysis.id)).toBe(1);
    expect(analysis.runs()).toBe(1);
  });
});
