import {
  type CFGFunction,
  type CFGInstruction,
  canDeoptimize,
  isEffectFree,
  isGuard,
  IR_CALL_BUILTIN,
  IR_DEOPTIMIZE,
} from "../ir/index.js";
import type { TargetModel } from "../target/model.js";
import { BackendLoweringError } from "../target/errors.js";
import { THROW_BUILTIN } from "../metadata/builtin-methods.js";
import { AOT_FLOAT_TO_STRING } from "../analyses/aot-legality.js";

export class UnsupportedSpeculationError extends BackendLoweringError {
  constructor(target: string, nodeType: string) {
    super(`target ${target} cannot deoptimize but ${nodeType} requires a frame state`);
    this.name = "UnsupportedSpeculationError";
  }
}

function deoptimizesOnItsOwn(node: CFGInstruction): boolean {
  if (isGuard(node) || node.type === IR_DEOPTIMIZE) return true;
  return canDeoptimize(node) && isEffectFree(node);
}

function throwsOutOfTheProgram(node: CFGInstruction): boolean {
  return node.type === IR_CALL_BUILTIN && String(node.props.name) === THROW_BUILTIN;
}

function rendersFloatText(node: CFGInstruction): boolean {
  return node.type === IR_CALL_BUILTIN && String(node.props.name) === AOT_FLOAT_TO_STRING;
}

export function capabilityCheck(graph: CFGFunction, target: TargetModel): void {
  const deoptimizes = target.capabilities.has("deopt");
  const terminates = target.capabilities.has("terminating-throw");
  const renders = target.capabilities.has("float-text");
  if (deoptimizes && terminates && renders) return;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!deoptimizes && deoptimizesOnItsOwn(node)) {
        throw new UnsupportedSpeculationError(target.name, node.type);
      }
      if (!terminates && throwsOutOfTheProgram(node)) {
        throw new BackendLoweringError(`target ${target.name} cannot lower ${THROW_BUILTIN}`);
      }
      if (!renders && rendersFloatText(node)) {
        throw new BackendLoweringError(
          `target ${target.name} cannot lower ${AOT_FLOAT_TO_STRING}`,
        );
      }
    }
  }
}
