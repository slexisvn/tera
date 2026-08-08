import { beforeEach, describe, expect, it } from "vitest";
import { CFGBlock, CFGFunction, resetIRNodeIds } from "../../../src/optimizing/ir/index.js";
import {
  DominatorTree,
  dominanceAnalysis,
  dominanceAnalysisId,
} from "../../../src/optimizing/analyses/dominance.js";
import {
  AnalysisManager,
  AnalysisRegistry,
} from "../../../src/optimizing/infra/analysis-manager.js";

beforeEach(() => resetIRNodeIds());

function diamond(): { graph: CFGFunction; blocks: Record<string, CFGBlock> } {
  const graph = new CFGFunction("diamond");
  const entry = graph.addBlock();
  const left = graph.addBlock();
  const right = graph.addBlock();
  const merge = graph.addBlock();
  entry.addSuccessor(left);
  entry.addSuccessor(right);
  left.addSuccessor(merge);
  right.addSuccessor(merge);
  return { graph, blocks: { entry, left, right, merge } };
}

describe("DominatorTree", () => {
  it("recognises that the entry dominates all blocks", () => {
    const { graph, blocks } = diamond();
    const tree = new DominatorTree(graph);
    for (const block of Object.values(blocks)) {
      expect(tree.dominates(blocks.entry, block)).toBe(true);
    }
  });

  it("does not treat an arm of the diamond as dominating the merge", () => {
    const { graph, blocks } = diamond();
    const tree = new DominatorTree(graph);
    expect(tree.dominates(blocks.left, blocks.merge)).toBe(false);
    expect(tree.dominates(blocks.right, blocks.merge)).toBe(false);
    expect(tree.dominates(blocks.left, blocks.right)).toBe(false);
  });

  it("treats a block as dominating itself", () => {
    const { graph, blocks } = diamond();
    const tree = new DominatorTree(graph);
    expect(tree.dominates(blocks.merge, blocks.merge)).toBe(true);
  });

  it("exposes immediate dominators", () => {
    const { graph, blocks } = diamond();
    const tree = new DominatorTree(graph);
    expect(tree.immediateDominator(blocks.entry)).toBeNull();
    expect(tree.immediateDominator(blocks.left)).toBe(blocks.entry);
    expect(tree.immediateDominator(blocks.merge)).toBe(blocks.entry);
  });

  it("handles a loop back edge without diverging", () => {
    const graph = new CFGFunction("loop");
    const entry = graph.addBlock();
    const head = graph.addBlock();
    const body = graph.addBlock();
    const exit = graph.addBlock();
    entry.addSuccessor(head);
    head.addSuccessor(body);
    body.addSuccessor(head);
    head.addSuccessor(exit);
    const tree = new DominatorTree(graph);

    expect(tree.dominates(head, body)).toBe(true);
    expect(tree.dominates(head, exit)).toBe(true);
    expect(tree.dominates(body, exit)).toBe(false);
  });
});

describe("dominanceAnalysis", () => {
  it("is resolved and cached through the AnalysisManager", () => {
    const { graph, blocks } = diamond();
    const registry = new AnalysisRegistry<CFGFunction>();
    registry.register(dominanceAnalysis);
    const analyses = new AnalysisManager<CFGFunction>(graph, registry);

    const tree = analyses.get(dominanceAnalysisId);
    expect(tree.dominates(blocks.entry, blocks.merge)).toBe(true);
    expect(analyses.get(dominanceAnalysisId)).toBe(tree);
  });
});
