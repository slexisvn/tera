import * as ir from "../ir/index.js";
import { markFrameStateValues, visitFrameStateValues } from "./frame-state-values.js";

type DceNode = ir.CFGInstruction;
type DceBlock = ir.CFGBlock;
type DceGraph = ir.CFGFunction;

export function deadCodeElimination(graph: DceGraph): number {
  let dceCount = 0;

  const liveNodes = new Set<number>();
  const worklist: DceNode[] = [];

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (isRequiredEffect(node)) {
        liveNodes.add(node.id);
        worklist.push(node);
      }
    }
  }

  while (worklist.length > 0) {
    const node = worklist.pop()!;
    for (const input of node.inputs) {
      if (input && !liveNodes.has(input.id)) {
        liveNodes.add(input.id);
        worklist.push(input);
      }
    }
    if (node.frameState) {
      markFrameStateValues(node.frameState, liveNodes, worklist);
    }
  }

  for (const param of graph.parameters) {
    liveNodes.add(param.id);
  }
  for (const block of graph.blocks) {
    for (const param of block.params || []) {
      liveNodes.add(param.id);
    }
  }

  for (const block of graph.blocks) {
    block.nodes = block.nodes.filter((node) => {
      if (liveNodes.has(node.id)) return true;
      node.inputs.forEach((inp) => {
        if (inp) inp.uses = inp.uses.filter((u) => u !== node);
      });
      dceCount++;
      return false;
    });
    const liveNodeSet = new Set<DceNode>(block.nodes);
    block.params = (block.params || []).filter((param) =>
      liveNodeSet.has(param),
    );
  }

  graph.rebuildUses?.();
  return dceCount;
}

function isRequiredEffect(node: DceNode): boolean {
  return node.effectKind !== ir.EFFECT_NONE && node.effectKind !== ir.EFFECT_READ;
}

export function eliminateDeadPhis(graph: DceGraph): number {
  const frameStateReferenced = new Set<DceNode>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!node.frameState) continue;
      visitFrameStateValues(node.frameState, (value) => {
        if (value instanceof ir.CFGInstruction) frameStateReferenced.add(value);
      });
    }
  }

  let removed = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of graph.blocks) {
      for (let index = block.params.length - 1; index >= 0; index--) {
        const phi = block.params[index];
        if (phi.uses.length > 0 || frameStateReferenced.has(phi)) continue;

        for (const input of phi.inputs) {
          if (input) input.uses = input.uses.filter((u) => u !== phi);
        }
        block.params.splice(index, 1);
        block.nodes = block.nodes.filter((n) => n !== phi);
        for (const pred of block.predecessors) {
          const args = pred.edgeArgs.get(block.id);
          if (args && index < args.length) args.splice(index, 1);
        }
        for (let j = index; j < block.params.length; j++) {
          block.params[j].props.index = j;
        }
        removed++;
        changed = true;
      }
    }
  }

  if (removed > 0) graph.rebuildUses?.();
  return removed;
}

export function eliminateUnreachableBlocks(graph: DceGraph): number {
  if (!graph.entry) return 0;

  const reachable = new Set<number>();
  const worklist = [graph.entry];
  reachable.add(graph.entry.id);

  while (worklist.length > 0) {
    const block = worklist.pop()!;
    for (const succ of block.successors) {
      if (!reachable.has(succ.id)) {
        reachable.add(succ.id);
        worklist.push(succ);
      }
    }
  }

  const origLen = graph.blocks.length;
  if (reachable.size === origLen) return 0;

  const deadBlocks = graph.blocks.filter((b) => !reachable.has(b.id));
  for (const dead of deadBlocks) {
    for (const node of dead.nodes) {
      node.inputs.forEach((inp) => {
        if (inp) inp.uses = inp.uses.filter((u) => u !== node);
      });
    }
    for (const succ of dead.successors) {
      succ.predecessors = succ.predecessors.filter((p) => p !== dead);
    }
  }

  graph.blocks = graph.blocks.filter((b) => reachable.has(b.id));
  graph.rebuildUses?.();
  return origLen - graph.blocks.length;
}
