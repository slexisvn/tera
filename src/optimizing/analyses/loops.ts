import type { CFGBlock, CFGFunction } from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";

export interface LoopInfo {
  readonly header: CFGBlock;
  readonly blocks: readonly CFGBlock[];
}

export function findLoops(graph: CFGFunction): LoopInfo[] {
  const loops: LoopInfo[] = [];
  const dfsOrder = computeDfsOrder(graph);

  for (const block of graph.blocks) {
    if (!block.isLoopHeader) continue;

    const bodyBlocks: CFGBlock[] = [];
    const visited = new Set<number>();
    const worklist: CFGBlock[] = [];

    visited.add(block.id);
    bodyBlocks.push(block);

    for (const pred of block.predecessors) {
      if (pred.id >= block.id || isBackEdgeWithOrder(pred, block, dfsOrder)) {
        if (!visited.has(pred.id)) {
          visited.add(pred.id);
          worklist.push(pred);
          bodyBlocks.push(pred);
        }
      }
    }

    while (worklist.length > 0) {
      const current = worklist.pop()!;
      for (const pred of current.predecessors) {
        if (!visited.has(pred.id)) {
          visited.add(pred.id);
          worklist.push(pred);
          bodyBlocks.push(pred);
        }
      }
    }

    loops.push({ header: block, blocks: bodyBlocks });
  }

  return loops;
}

function computeDfsOrder(graph: CFGFunction): Map<number, number> {
  const visited = new Set<number>();
  const stack: CFGBlock[] = graph.entry ? [graph.entry] : [];
  const dfsOrder = new Map<number, number>();
  let order = 0;

  while (stack.length > 0) {
    const block = stack.pop()!;
    if (visited.has(block.id)) continue;
    visited.add(block.id);
    dfsOrder.set(block.id, order++);
    for (const succ of block.successors) stack.push(succ);
  }

  return dfsOrder;
}

function isBackEdgeWithOrder(
  from: CFGBlock,
  to: CFGBlock,
  dfsOrder: Map<number, number>,
): boolean {
  const fromOrder = dfsOrder.get(from.id);
  const toOrder = dfsOrder.get(to.id);
  return fromOrder !== undefined && toOrder !== undefined && fromOrder >= toOrder;
}

export const loopAnalysisId = analysisId<readonly LoopInfo[]>("loops");

export const loopAnalysis: AnalysisPass<CFGFunction, readonly LoopInfo[]> = {
  id: loopAnalysisId,
  run: (graph) => findLoops(graph),
};
