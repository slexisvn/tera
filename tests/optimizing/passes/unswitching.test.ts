import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irJump,
  irReturn,
  resetIRNodeIds,
  IR_BRANCH,
  type CFGBlock,
  type CFGFunction as Graph,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { DominatorTree } from "../../../src/optimizing/analyses/dominance.js";
import { LoopForest } from "../../../src/optimizing/analyses/loops.js";
import { loopUnswitching } from "../../../src/optimizing/passes/unswitching.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

const BUDGET = 48;

interface Counted {
  readonly graph: Graph;
  readonly preheader: CFGBlock;
  readonly header: CFGBlock;
  readonly test: CFGBlock;
}

function proven(node: ReturnType<typeof irInt32Add>) {
  node.props.noOverflow = true;
  return node;
}

function countingLoop(invariant: boolean): Counted {
  const graph = new CFGFunction("counted");
  graph.declaredSignature = { params: ["int", "int"], names: ["n", "flag"], returns: "int" };
  const n = graph.addParameter(0);
  const flag = graph.addParameter(1);

  const preheader = graph.addBlock();
  const header = graph.addBlock();
  const test = graph.addBlock();
  const heavy = graph.addBlock();
  const light = graph.addBlock();
  const latch = graph.addBlock();
  const exit = graph.addBlock();

  const zero = preheader.addNode(irConstant(0));
  const one = preheader.addNode(irConstant(1));
  const hoisted = invariant ? preheader.addNode(irInt32Compare("<", flag, one)) : null;
  preheader.addNode(irJump(header));
  link(preheader, header);

  const index = addPhi(header, [zero]);
  const total = addPhi(header, [zero]);
  header.addNode(irBranch(header.addNode(irInt32Compare("<", index, n)), test, exit));
  link(header, test);
  link(header, exit);

  const decides = hoisted ?? test.addNode(irInt32Compare("<", index, one));
  test.addNode(irBranch(decides, heavy, light));
  link(test, heavy);
  link(test, light);

  const raised = heavy.addNode(proven(irInt32Add(total, index)));
  heavy.addNode(irJump(latch));
  const kept = light.addNode(proven(irInt32Add(total, one)));
  light.addNode(irJump(latch));
  link(heavy, latch);
  link(light, latch);

  const merged = addPhi(latch, [raised, kept]);
  const stepped = latch.addNode(proven(irInt32Add(index, one)));
  latch.addNode(irJump(header));
  link(latch, header);
  index.addInput(stepped);
  total.addInput(merged);
  header.isLoopHeader = true;

  exit.addNode(irReturn(total));
  graph.rebuildUses();
  return { graph, preheader, header, test };
}

function unswitch(graph: Graph, budget = BUDGET): number {
  const dominators = new DominatorTree(graph);
  return loopUnswitching(graph, new LoopForest(graph, dominators), budget);
}

const branchesIn = (graph: Graph) =>
  graph.blocks.flatMap((block) => block.nodes).filter((node) => node.type === IR_BRANCH);

describe("loopUnswitching", () => {
  it("clones the loop and tests the invariant condition once, in the preheader", () => {
    const { graph, preheader } = countingLoop(true);

    expect(unswitch(graph)).toBe(1);
    expect(preheader.getTerminator()!.type).toBe(IR_BRANCH);
    expect(preheader.successors).toHaveLength(2);
    expect(graph.blocks.filter((block) => block.isLoopHeader)).toHaveLength(2);
  });

  it("drops the arm each copy of the loop no longer reaches", () => {
    const { graph } = countingLoop(true);
    const before = graph.blocks.length;

    unswitch(graph);
    expect(graph.blocks.length).toBe(before + 3);
    for (const block of graph.blocks) {
      if (block === graph.entry) continue;
      expect(block.predecessors.length).toBeGreaterThan(0);
    }
  });

  it("leaves each copy of the loop deciding nothing", () => {
    const { graph, test } = countingLoop(true);
    unswitch(graph);

    expect(test.getTerminator()!.type).toBe("Jump");
    expect(branchesIn(graph)).toHaveLength(3);
  });

  it("keeps the graph in SSA form", () => {
    const { graph } = countingLoop(true);
    unswitch(graph);

    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("gives the cloned header the same entry value as the original", () => {
    const { graph, header, preheader } = countingLoop(true);
    unswitch(graph);

    const cloned = graph.blocks.find(
      (block) => block !== header && block.predecessors.includes(preheader),
    )!;
    expect(cloned.phis).toHaveLength(header.phis.length);
    for (let at = 0; at < cloned.phis.length; at++) {
      expect(cloned.phis[at]!.inputs[0]).toBe(header.phis[at]!.inputs[0]);
    }
  });

  it("hands the exit block one incoming value per copy", () => {
    const { graph, header } = countingLoop(true);
    const exit = header.successors.find((block) => block.getTerminator()!.type === "Return")!;

    unswitch(graph);
    expect(exit.predecessors).toHaveLength(2);
  });

  it("leaves a loop whose condition changes with the induction variable alone", () => {
    const { graph } = countingLoop(false);
    const before = graph.blocks.length;

    expect(unswitch(graph)).toBe(0);
    expect(graph.blocks.length).toBe(before);
  });

  it("refuses a loop larger than the budget it was given", () => {
    const { graph } = countingLoop(true);

    expect(unswitch(graph, 1)).toBe(0);
  });

  it("does nothing when the budget is zero", () => {
    const { graph } = countingLoop(true);

    expect(unswitch(graph, 0)).toBe(0);
  });
});
