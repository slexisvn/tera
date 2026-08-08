import type { CFGFunction, CFGInstruction } from "./index.js";
import { replaceValueUses, detachNode } from "./graph-edit.js";

export class GraphEditor {
  constructor(private readonly graph: CFGFunction) {}

  replaceAllUses(from: CFGInstruction, to: CFGInstruction): void {
    if (from === to) return;
    replaceValueUses(this.graph, from, to);
    this.replaceInEdgeArgs(from, to);
  }

  setInput(node: CFGInstruction, index: number, value: CFGInstruction): void {
    node.replaceInput(index, value);
  }

  insertBefore(anchor: CFGInstruction, node: CFGInstruction): void {
    const block = anchor.block;
    if (block === null) throw new Error("insertBefore anchor has no block");
    node.block = block;
    block.nodes.splice(block.nodes.indexOf(anchor), 0, node);
  }

  insertAfter(anchor: CFGInstruction, node: CFGInstruction): void {
    const block = anchor.block;
    if (block === null) throw new Error("insertAfter anchor has no block");
    node.block = block;
    block.nodes.splice(block.nodes.indexOf(anchor) + 1, 0, node);
  }

  remove(node: CFGInstruction): void {
    detachNode(node);
    const block = node.block;
    if (block !== null) {
      block.nodes = block.nodes.filter((candidate) => candidate !== node);
      if (block.terminator === node) block.terminator = null;
    }
    node.block = null;
  }

  private replaceInEdgeArgs(from: CFGInstruction, to: CFGInstruction): void {
    for (const block of this.graph.blocks) {
      for (const args of block.edgeArgs.values()) {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === from) args[i] = to;
        }
      }
    }
  }
}
