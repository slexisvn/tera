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

export function homeFloatingValues(graph: ir.CFGFunction): number {
  const entry = graph.entry;
  if (entry === null) return 0;
  const floating: GraphNode[] = [];
  const seen = new Set<GraphNode>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      for (const input of node.inputs) {
        if (!input || input.block !== null) continue;
        if (input.type === ir.IR_PARAMETER || seen.has(input)) continue;
        seen.add(input);
        floating.push(input);
      }
    }
  }
  for (const value of floating) ir.homeInstruction(value, entry);
  return floating.length;
}

export function maxNodeId(graph: ir.CFGFunction): number {
  let max = -1;
  for (const param of graph.parameters) max = Math.max(max, param.id);
  for (const block of graph.blocks) {
    for (const phi of block.phis) max = Math.max(max, phi.id);
    for (const node of block.nodes) max = Math.max(max, node.id);
  }
  return max;
}

export function nodeIdStamper(
  graph: ir.CFGFunction,
): (node: ir.CFGInstruction) => ir.CFGInstruction {
  let nextId = maxNodeId(graph) + 1;
  return (node) => {
    node.id = nextId++;
    return node;
  };
}
