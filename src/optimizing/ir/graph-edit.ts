import * as ir from "../ir/index.js";
import { replaceGraphFrameStateValue } from "./frame-state-values.js";

type GraphNode = ir.CFGInstruction;
type GraphFunction = ir.CFGFunction;

export function replaceValueUses(
  graph: GraphFunction,
  node: GraphNode,
  replacement: GraphNode,
): void {
  for (const use of [...node.uses]) {
    for (let i = 0; i < use.inputs.length; i++) {
      if (use.inputs[i] === node) use.replaceInput(i, replacement);
    }
  }
  replaceGraphFrameStateValue(graph, node, replacement);
}

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
