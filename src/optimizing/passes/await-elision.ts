import { IR_AWAIT, type CFGFunction, type CFGInstruction } from "../ir/index.js";

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

  for (const node of suspends) {
    const value = node.inputs[0]!;
    for (const use of [...node.uses]) {
      for (let index = 0; index < use.inputs.length; index++) {
        if (use.inputs[index] === node) use.replaceInput(index, value);
      }
    }
    value.uses = value.uses.filter((use) => use !== node);
    node.uses = [];
    node.inputs = [];
    const block = node.block;
    if (block !== null) block.nodes.splice(block.nodes.indexOf(node), 1);
  }
  graph.rebuildUses();
  return suspends.length;
}
