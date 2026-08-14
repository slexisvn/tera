import { IR_PHI, type CFGBlock, type CFGFunction, type CFGInstruction } from "../ir/index.js";

export interface ValueLiveness {
  liveIn(block: CFGBlock): ReadonlySet<CFGInstruction>;
  liveOut(block: CFGBlock): ReadonlySet<CFGInstruction>;
}

const NOTHING: ReadonlySet<CFGInstruction> = new Set();

function sameMembers(
  left: ReadonlySet<CFGInstruction>,
  right: ReadonlySet<CFGInstruction>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of right) {
    if (!left.has(value)) return false;
  }
  return true;
}

function liveOutOf(
  block: CFGBlock,
  liveIn: ReadonlyMap<CFGBlock, ReadonlySet<CFGInstruction>>,
): Set<CFGInstruction> {
  const live = new Set<CFGInstruction>();
  for (const successor of block.successors) {
    for (const value of liveIn.get(successor) ?? NOTHING) live.add(value);
    const edge = successor.predecessors.indexOf(block);
    for (const phi of successor.phis) {
      const incoming = phi.inputs[edge];
      if (incoming !== undefined) live.add(incoming);
    }
  }
  return live;
}

export function computeValueLiveness(graph: CFGFunction): ValueLiveness {
  const liveIn = new Map<CFGBlock, ReadonlySet<CFGInstruction>>();
  for (const block of graph.blocks) liveIn.set(block, NOTHING);

  const pending = [...graph.blocks];
  const queued = new Set(pending);
  while (pending.length > 0) {
    const block = pending.pop()!;
    queued.delete(block);
    const live = liveOutOf(block, liveIn);
    for (let at = block.nodes.length - 1; at >= 0; at--) {
      const node = block.nodes[at]!;
      live.delete(node);
      if (node.type === IR_PHI) continue;
      for (const input of node.inputs) live.add(input);
    }
    if (sameMembers(liveIn.get(block)!, live)) continue;
    liveIn.set(block, live);
    for (const predecessor of block.predecessors) {
      if (queued.has(predecessor)) continue;
      queued.add(predecessor);
      pending.push(predecessor);
    }
  }

  return {
    liveIn: (block) => liveIn.get(block) ?? NOTHING,
    liveOut: (block) => liveOutOf(block, liveIn),
  };
}
