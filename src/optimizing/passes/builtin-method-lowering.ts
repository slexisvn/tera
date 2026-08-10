import {
  type CFGFunction,
  type CFGInstruction,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  irCallBuiltin,
  irRequiresFrameState,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import type { TypeInference } from "../analyses/type-inference.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicFor,
  type BuiltinMethodIntrinsic,
} from "../metadata/builtin-methods.js";

type Lowering = {
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction | null;
  readonly operands: CFGInstruction[];
  readonly intrinsic: BuiltinMethodIntrinsic;
};

function intrinsicOf(
  receiver: CFGInstruction,
  propName: unknown,
  types: TypeInference,
): BuiltinMethodIntrinsic | null {
  return builtinMethodIntrinsicFor(types.typeOf(receiver), String(propName));
}

function getterLowering(node: CFGInstruction, types: TypeInference): Lowering | null {
  const receiver = node.inputs[0];
  if (receiver === undefined) return null;
  const intrinsic = intrinsicOf(receiver, node.props.propName, types);
  if (intrinsic === null || !intrinsic.getter) return null;
  return { node, callee: null, operands: [receiver], intrinsic };
}

function callLowering(node: CFGInstruction, types: TypeInference): Lowering | null {
  if (node.props.isMethod !== true) return null;
  const callee = node.inputs[0];
  const receiver = node.inputs[1];
  if (callee === undefined || receiver === undefined) return null;
  if (callee.type !== IR_GENERIC_GET_PROP || callee.inputs[0] !== receiver) return null;
  const intrinsic = intrinsicOf(receiver, callee.props.propName, types);
  if (intrinsic === null || intrinsic.getter) return null;
  if (node.inputs.length - 1 !== intrinsic.argCount) return null;
  return { node, callee, operands: node.inputs.slice(1), intrinsic };
}

function loweringFor(node: CFGInstruction, types: TypeInference): Lowering | null {
  if (node.type === IR_GENERIC_GET_PROP) return getterLowering(node, types);
  if (node.type === IR_GENERIC_CALL) return callLowering(node, types);
  return null;
}

export function lowerBuiltinMethods(graph: CFGFunction, types: TypeInference): number {
  const lowerings: Lowering[] = [];
  const lowered = new Set<CFGInstruction>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const lowering = loweringFor(node, types);
      if (lowering === null) continue;
      lowerings.push(lowering);
      lowered.add(node);
    }
  }
  if (lowerings.length === 0) return 0;

  const editor = new GraphEditor(graph);
  let count = 0;
  for (const { node, callee, operands, intrinsic } of lowerings) {
    if (callee !== null && lowered.has(callee)) continue;
    const replacement = irCallBuiltin(
      intrinsic.qualifiedName,
      operands,
      builtinMethodCallMetadata(intrinsic),
    );
    if (irRequiresFrameState(replacement)) replacement.frameState = node.frameState;
    editor.insertBefore(node, replacement);
    editor.replaceAllUses(node, replacement);
    editor.remove(node);
    if (callee !== null && callee.uses.length === 0) editor.remove(callee);
    count++;
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
