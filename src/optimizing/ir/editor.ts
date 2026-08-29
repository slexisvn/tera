import type { CFGFunction, CFGInstruction } from "./index.js";
import { replaceValueUses, detachNode } from "./graph-edit.js";
import { clearFrameStateIndex, frameStateReferences } from "./frame-state-values.js";

export class GraphEditor {
  constructor(private readonly graph: CFGFunction) {}

  replaceAllUses(from: CFGInstruction, to: CFGInstruction): void {
    if (from === to) return;
    replaceValueUses(this.graph, from, to);
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

  removeIfDead(node: CFGInstruction | null | undefined): boolean {
    if (!node || node.uses.length > 0) return false;
    if (frameStateReferences(this.graph, node)) return false;
    this.remove(node);
    return true;
  }

  removeDeadChain(node: CFGInstruction | null | undefined): number {
    if (!node) return 0;
    clearFrameStateIndex(this.graph);
    let removed = 0;
    const worklist = [node];
    while (worklist.length > 0) {
      const candidate = worklist.pop()!;
      if (candidate.block === null) continue;
      const inputs = [...candidate.inputs];
      const carried = candidate.frameState !== null && candidate.frameState !== undefined;
      if (!this.removeIfDead(candidate)) continue;
      removed++;
      if (carried) clearFrameStateIndex(this.graph);
      for (const input of inputs) worklist.push(input);
    }
    return removed;
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
}
