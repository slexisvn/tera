import type { CFGBlock, CFGFunction } from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import {
  computeDominatorData,
  buildDominatorTree,
  type DominatorGraph,
} from "./dominance-core.js";

export class DominatorTree {
  private readonly enter = new Map<CFGBlock, number>();
  private readonly exit = new Map<CFGBlock, number>();
  private readonly idom: Map<CFGBlock, CFGBlock | null>;
  private readonly children: Map<CFGBlock, CFGBlock[]>;
  private readonly rpo: readonly CFGBlock[];
  private frontiers: Map<CFGBlock, Set<CFGBlock>> | null = null;

  constructor(graph: CFGFunction) {
    const domGraph = graph as unknown as DominatorGraph;
    const { idom: dominators, postorder } = computeDominatorData(domGraph);
    const tree = buildDominatorTree(domGraph, dominators);
    this.children = tree.children as unknown as Map<CFGBlock, CFGBlock[]>;
    this.idom = tree.idomMap as unknown as Map<CFGBlock, CFGBlock | null>;
    this.rpo = Object.freeze([...postorder].reverse() as CFGBlock[]);
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

  reversePostorder(): readonly CFGBlock[] {
    return this.rpo;
  }

  frontierOf(block: CFGBlock): ReadonlySet<CFGBlock> {
    this.frontiers ??= this.computeFrontiers();
    return this.frontiers.get(block) ?? EMPTY_FRONTIER;
  }

  private computeFrontiers(): Map<CFGBlock, Set<CFGBlock>> {
    const frontiers = new Map<CFGBlock, Set<CFGBlock>>();
    const record = (owner: CFGBlock, join: CFGBlock): void => {
      let blocks = frontiers.get(owner);
      if (blocks === undefined) {
        blocks = new Set<CFGBlock>();
        frontiers.set(owner, blocks);
      }
      blocks.add(join);
    };
    for (const join of this.rpo) {
      if (join.predecessors.length < 2) continue;
      const boundary = this.idom.get(join) ?? null;
      for (const predecessor of join.predecessors) {
        let walk: CFGBlock | null = predecessor;
        while (walk !== null && walk !== boundary) {
          record(walk, join);
          walk = this.idom.get(walk) ?? null;
        }
      }
    }
    return frontiers;
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

const EMPTY_FRONTIER: ReadonlySet<CFGBlock> = new Set<CFGBlock>();

export const dominanceAnalysisId = analysisId<DominatorTree>("dominance");

export const dominanceAnalysis: AnalysisPass<CFGFunction, DominatorTree> = {
  id: dominanceAnalysisId,
  run: (graph) => new DominatorTree(graph),
};
