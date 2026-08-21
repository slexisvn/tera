import { IR_AWAIT, type CFGFunction, type CFGInstruction } from "../ir/index.js";
import { detachUsesOfAll, replaceValueUses, retainNodes } from "../ir/graph-edit.js";

function awaits(graph: CFGFunction): readonly CFGInstruction[] {
  const found: CFGInstruction[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_AWAIT) found.push(node);
    }
  }
  return found;
}

export function elideAwaits(
  graph: CFGFunction,
  yields: (node: CFGInstruction) => boolean,
): number {
  const suspends = awaits(graph).filter((node) => !yields(node));
  if (suspends.length === 0) return 0;

  const elided = new Set(suspends);
  for (const node of suspends) replaceValueUses(graph, node, node.inputs[0]!);
  detachUsesOfAll(elided);
  for (const node of elided) node.inputs = [];
  for (const block of graph.blocks) retainNodes(block, elided);
  graph.rebuildUses();
  return suspends.length;
}
