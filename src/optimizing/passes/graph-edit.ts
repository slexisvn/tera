import * as ir from "../ir/index.js";

type GraphNode = ir.CFGInstruction;

export function detachInputs(node: GraphNode): void {
  for (const input of node.inputs) {
    if (input?.uses) input.uses = input.uses.filter((use) => use !== node);
  }
  node.inputs = [];
}

export function detachNode(node: GraphNode): void {
  for (const input of node.inputs) {
    if (input?.uses) input.uses = input.uses.filter((use) => use !== node);
  }
  node.uses = [];
}
