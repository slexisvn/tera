import {
  irCallKnownFunction,
  IR_GENERIC_MOD,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { producedType } from "../metadata/produced-type.js";
import { TypeKind } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { FLOAT_MOD_FN } from "../prelude/float-mod.js";

const OPERANDS = 2;

function countsWhole(
  value: CFGInstruction | undefined,
  graph: CFGFunction,
  types: TypeInference,
): boolean {
  return value !== undefined && producedType(value, types, graph.classes).kind === TypeKind.Smi;
}

function fractionalOperands(
  node: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): readonly CFGInstruction[] | null {
  if (node.type !== IR_GENERIC_MOD || node.inputs.length !== OPERANDS) return null;
  if (node.inputs.every((input) => countsWhole(input, graph, types))) return null;
  return node.inputs;
}

export function lowerFloatRemainder(graph: CFGFunction, types: TypeInference): number {
  const signature = graph.calleeSignatures?.get(FLOAT_MOD_FN);
  if (signature === undefined) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const operands = fractionalOperands(node, graph, types);
      if (operands === null) continue;
      const call = stamp(
        irCallKnownFunction({ name: FLOAT_MOD_FN, declaredSignature: signature } as never, [
          ...operands,
        ]),
      );
      call.frameState = node.frameState;
      editor.insertBefore(node, call);
      editor.replaceAllUses(node, call);
      editor.remove(node);
      count += 1;
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
