import * as ir from "../ir/index.js";
import { markFrameStateValues, visitFrameStateValues } from "../ir/frame-state-values.js";
import { replaceValueUses } from "../ir/graph-edit.js";
import { disconnect, removePhi } from "../ir/cfg-edit.js";

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
    for (const phi of [...block.phis]) {
      if (liveNodes.has(phi.id)) continue;
      removePhi(block, phi);
      dceCount++;
    }
    block.nodes = block.nodes.filter((node) => {
      if (liveNodes.has(node.id)) return true;
      node.inputs.forEach((inp) => {
        if (inp) inp.uses = inp.uses.filter((u) => u !== node);
      });
      dceCount++;
      return false;
    });
  }

  graph.rebuildUses?.();
  return dceCount;
}

function isRequiredEffect(node: DceNode): boolean {
  return node.effectKind !== ir.EFFECT_NONE && node.effectKind !== ir.EFFECT_READ;
}

export function eliminateTrivialPhis(graph: DceGraph): number {
  const folds = new Map<DceNode, DceNode>();
  const worklist: DceNode[] = [];
  const queued = new Set<DceNode>();

  const enqueue = (phi: DceNode): void => {
    if (queued.has(phi)) return;
    queued.add(phi);
    worklist.push(phi);
  };

  for (const block of graph.blocks) {
    for (const phi of block.phis) enqueue(phi);
  }

  while (worklist.length > 0) {
    const phi = worklist.pop()!;
    queued.delete(phi);
    if (folds.has(phi)) continue;

    let unique: DceNode | null = null;
    let trivial = true;
    for (const input of phi.inputs) {
      if (!input || input === phi) continue;
      if (unique === null) unique = input;
      else if (unique !== input) {
        trivial = false;
        break;
      }
    }
    if (!trivial || unique === null) continue;

    const phiUses = phi.uses.filter((use) => use.type === ir.IR_PHI && use !== phi);
    replaceValueUses(graph, phi, unique);
    folds.set(phi, unique);
    for (const use of phiUses) enqueue(use);
  }

  if (folds.size === 0) return 0;

  for (const block of graph.blocks) {
    for (const phi of [...block.phis]) {
      if (folds.has(phi)) removePhi(block, phi);
    }
  }

  graph.rebuildUses?.();
  return folds.size;
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
      for (const phi of [...block.phis]) {
        if (phi.uses.length > 0 || frameStateReferenced.has(phi)) continue;
        removePhi(block, phi);
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
    for (const succ of [...dead.successors]) {
      if (reachable.has(succ.id)) disconnect(dead, succ);
    }
  }

  graph.blocks = graph.blocks.filter((b) => reachable.has(b.id));
  graph.rebuildUses?.();
  return origLen - graph.blocks.length;
}
