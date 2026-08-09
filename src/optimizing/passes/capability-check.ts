import {
  type CFGFunction,
  type CFGInstruction,
  EFFECT_GUARD,
  IR_DEOPTIMIZE,
  irRequiresFrameState,
} from "../ir/index.js";
import type { TargetModel } from "../target/model.js";

const RECONSTRUCTION_ONLY = new Set(["call", "alloc", "read", "write"]);

export class UnsupportedSpeculationError extends Error {
  constructor(target: string, nodeType: string) {
    super(`target ${target} cannot deoptimize but ${nodeType} requires a frame state`);
    this.name = "UnsupportedSpeculationError";
  }
}

function deoptimizesOnItsOwn(node: CFGInstruction): boolean {
  if (node.effectKind === EFFECT_GUARD || node.type === IR_DEOPTIMIZE) return true;
  return irRequiresFrameState(node) && !RECONSTRUCTION_ONLY.has(node.effectKind);
}

export function capabilityCheck(graph: CFGFunction, target: TargetModel): void {
  if (target.capabilities.has("deopt")) return;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (deoptimizesOnItsOwn(node)) {
        throw new UnsupportedSpeculationError(target.name, node.type);
      }
    }
  }
}
