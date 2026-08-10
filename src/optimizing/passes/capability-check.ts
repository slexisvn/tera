import {
  type CFGFunction,
  type CFGInstruction,
  canDeoptimize,
  isEffectFree,
  isGuard,
  IR_DEOPTIMIZE,
} from "../ir/index.js";
import type { TargetModel } from "../target/model.js";

export class UnsupportedSpeculationError extends Error {
  constructor(target: string, nodeType: string) {
    super(`target ${target} cannot deoptimize but ${nodeType} requires a frame state`);
    this.name = "UnsupportedSpeculationError";
  }
}

function deoptimizesOnItsOwn(node: CFGInstruction): boolean {
  if (isGuard(node) || node.type === IR_DEOPTIMIZE) return true;
  return canDeoptimize(node) && isEffectFree(node);
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
