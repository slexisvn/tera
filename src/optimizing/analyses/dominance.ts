import type { CFGBlock, CFGFunction } from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import {
  computeDominators,
  buildDominatorTree,
  type DominatorGraph,
} from "./dominance-core.js";

export class DominatorTree {
  private readonly enter = new Map<CFGBlock, number>();
  private readonly exit = new Map<CFGBlock, number>();
  private readonly idom: Map<CFGBlock, CFGBlock | null>;
  private readonly children: Map<CFGBlock, CFGBlock[]>;

  constructor(graph: CFGFunction) {
    const domGraph = graph as unknown as DominatorGraph;
    const dominators = computeDominators(domGraph);
    const tree = buildDominatorTree(domGraph, dominators);
    this.children = tree.children as unknown as Map<CFGBlock, CFGBlock[]>;
    this.idom = tree.idomMap as unknown as Map<CFGBlock, CFGBlock | null>;
    if (graph.entry !== null) this.number(graph.entry);
  }

  dominates(ancestor: CFGBlock, descendant: CFGBlock): boolean {
    const enterA = this.enter.get(ancestor);
    const exitA = this.exit.get(ancestor);
    const enterB = this.enter.get(descendant);
    const exitB = this.exit.get(descendant);
    if (enterA === undefined || exitA === undefined) return false;
    if (enterB === undefined || exitB === undefined) return false;
    return enterA <= enterB && exitB <= exitA;
  }

  immediateDominator(block: CFGBlock): CFGBlock | null {
    return this.idom.get(block) ?? null;
  }

  childrenOf(block: CFGBlock): readonly CFGBlock[] {
    return this.children.get(block) ?? [];
  }

  private number(root: CFGBlock): void {
    let clock = 0;
    const stack: Array<{ block: CFGBlock; index: number }> = [{ block: root, index: 0 }];
    this.enter.set(root, clock++);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const kids = this.children.get(top.block) ?? [];
      if (top.index < kids.length) {
        const child = kids[top.index++]!;
        this.enter.set(child, clock++);
        stack.push({ block: child, index: 0 });
      } else {
        this.exit.set(top.block, clock++);
        stack.pop();
      }
    }
  }
}

export const dominanceAnalysisId = analysisId<DominatorTree>("dominance");

export const dominanceAnalysis: AnalysisPass<CFGFunction, DominatorTree> = {
  id: dominanceAnalysisId,
  run: (graph) => new DominatorTree(graph),
};
