import {
  type CFGFunction,
  type CFGInstruction,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  irCallBuiltin,
  irCheckPrimitive,
  irRequiresFrameState,
  isGuardablePrimitive,
  primitiveTypeNamed,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import type { TypeInference } from "../analyses/type-inference.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicFor,
  builtinNamespaceIntrinsic,
  type BuiltinMethodIntrinsic,
} from "../metadata/builtin-methods.js";
import { IR_LOAD_GLOBAL } from "../ir/index.js";

type Lowering = {
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction | null;
  readonly operands: CFGInstruction[];
  readonly intrinsic: BuiltinMethodIntrinsic;
  readonly guardPrimitive: string | null;
};

type Resolution = {
  readonly intrinsic: BuiltinMethodIntrinsic;
  readonly guardPrimitive: string | null;
};

function observedPrimitive(site: CFGInstruction): string | null {
  const observed = site.props.receiverPrimitive;
  if (typeof observed !== "string" || !isGuardablePrimitive(observed)) return null;
  return observed;
}

function resolve(
  receiver: CFGInstruction,
  site: CFGInstruction,
  propName: unknown,
  types: TypeInference,
): Resolution | null {
  const declared = builtinMethodIntrinsicFor(types.typeOf(receiver), String(propName));
  if (declared !== null) return { intrinsic: declared, guardPrimitive: null };
  const observed = observedPrimitive(site);
  if (observed === null) return null;
  const guarded = builtinMethodIntrinsicFor(primitiveTypeNamed(observed), String(propName));
  return guarded === null ? null : { intrinsic: guarded, guardPrimitive: observed };
}

function getterLowering(node: CFGInstruction, types: TypeInference): Lowering | null {
  const receiver = node.inputs[0];
  if (receiver === undefined) return null;
  const resolved = resolve(receiver, node, node.props.propName, types);
  if (resolved === null || !resolved.intrinsic.getter) return null;
  return { node, callee: null, operands: [receiver], ...resolved };
}

function callLowering(node: CFGInstruction, types: TypeInference): Lowering | null {
  if (node.props.isMethod !== true) return null;
  const callee = node.inputs[0];
  const receiver = node.inputs[1];
  if (callee === undefined || receiver === undefined) return null;
  if (callee.type !== IR_GENERIC_GET_PROP || callee.inputs[0] !== receiver) return null;
  const resolved = resolve(receiver, callee, callee.props.propName, types);
  if (resolved === null || resolved.intrinsic.getter) return null;
  if (node.inputs.length - 1 !== resolved.intrinsic.argCount) return null;
  return { node, callee, operands: node.inputs.slice(1), ...resolved };
}

function namespaceLowering(node: CFGInstruction): Lowering | null {
  const callee = node.inputs[0];
  if (callee === undefined || callee.type !== IR_GENERIC_GET_PROP) return null;
  const namespaceValue = callee.inputs[0];
  if (namespaceValue === undefined || namespaceValue.type !== IR_LOAD_GLOBAL) return null;
  const operands = node.inputs.slice(2);
  const intrinsic = builtinNamespaceIntrinsic(
    String(namespaceValue.props.name),
    String(callee.props.propName),
    operands.length,
  );
  if (intrinsic === null) return null;
  return { node, callee, operands, intrinsic, guardPrimitive: null };
}

function loweringFor(node: CFGInstruction, types: TypeInference): Lowering | null {
  if (node.type === IR_GENERIC_GET_PROP) return getterLowering(node, types);
  if (node.type === IR_GENERIC_CALL) return callLowering(node, types) ?? namespaceLowering(node);
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
  for (const { node, callee, operands, intrinsic, guardPrimitive } of lowerings) {
    if (callee !== null && lowered.has(callee)) continue;
    const arguments_ = [...operands];
    if (guardPrimitive !== null) {
      const guard = irCheckPrimitive(arguments_[0], guardPrimitive);
      guard.frameState = node.frameState;
      editor.insertBefore(node, guard);
      arguments_[0] = guard;
    }
    const replacement = irCallBuiltin(
      intrinsic.qualifiedName,
      arguments_,
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
