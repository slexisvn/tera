import {
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_GET_PROP,
  IR_NEW_ARRAY,
  irCallBuiltin,
  irConstant,
  irCheckPrimitive,
  irLoadArrayLength,
  irRequiresFrameState,
  isGuardablePrimitive,
  primitiveTypeNamed,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { boundedIndex, measuredAlready, type Stamp } from "./guards.js";
import { DominatorTree } from "../analyses/dominance.js";
import type { TypeInference } from "../analyses/type-inference.js";
import type { DeclaredDefault } from "../types/signature.js";
import { type NominalTypes } from "../types/declared.js";
import { producedType } from "../metadata/produced-type.js";
import { TypeKind } from "../types/lattice.js";
import type { TargetModel } from "../target/model.js";

import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicFor,
  builtinNamespaceIntrinsic,
  type BuiltinIntrinsic,
  type BuiltinMethodIntrinsic,
} from "../metadata/builtin-methods.js";
import { IR_LOAD_GLOBAL } from "../ir/index.js";

const ARRAY_LENGTH = "length";
const INDEXED_CHARACTER = "char_at";
const COUNTED_CHARACTERS = "length";
const OUT_OF_RANGE = "string index is out of range";
const RECEIVER = 0;
const SUBSCRIPT = 1;

const NUMERIC_KINDS: ReadonlySet<string> = new Set<string>([
  TypeKind.Smi,
  TypeKind.Double,
  TypeKind.Number,
]);
const RECEIVER_AND_INDEX = 2;
const TAGGED_VALUES = "tagged-values";

type Lowering = {
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction | null;
  readonly operands: CFGInstruction[];
  readonly intrinsic: BuiltinMethodIntrinsic;
  readonly guardPrimitive: string | null;
  readonly countedBy?: BuiltinMethodIntrinsic;
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
  classes: NominalTypes | null,
): Resolution | null {
  const declared = builtinMethodIntrinsicFor(producedType(receiver, types, classes), String(propName));
  if (declared !== null) return { intrinsic: declared, guardPrimitive: null };
  const observed = observedPrimitive(site);
  if (observed === null) return null;
  const guarded = builtinMethodIntrinsicFor(primitiveTypeNamed(observed), String(propName));
  return guarded === null ? null : { intrinsic: guarded, guardPrimitive: observed };
}

function getterLowering(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): Lowering | null {
  const receiver = node.inputs[0];
  if (receiver === undefined) return null;
  const resolved = resolve(receiver, node, node.props.propName, types, classes);
  if (resolved === null || !resolved.intrinsic.getter) return null;
  return { node, callee: null, operands: [receiver], ...resolved };
}

function callLowering(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): Lowering | null {
  if (node.props.isMethod !== true) return null;
  const callee = node.inputs[0];
  const receiver = node.inputs[1];
  if (callee === undefined || receiver === undefined) return null;
  if (callee.type !== IR_GENERIC_GET_PROP || callee.inputs[0] !== receiver) return null;
  const resolved = resolve(receiver, callee, callee.props.propName, types, classes);
  if (resolved === null || resolved.intrinsic.getter) return null;
  const arity = node.inputs.length - 1;
  if (arity < resolved.intrinsic.requiredArgCount || arity > resolved.intrinsic.surfaceArgCount) {
    return null;
  }
  return { node, callee, operands: node.inputs.slice(1), ...resolved };
}

function indexLowering(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): Lowering | null {
  if (node.inputs.length !== RECEIVER_AND_INDEX) return null;
  const [receiver, index] = node.inputs;
  if (!NUMERIC_KINDS.has(producedType(index!, types, classes).kind)) return null;
  const received = producedType(receiver!, types, classes);
  const intrinsic = builtinMethodIntrinsicFor(received, INDEXED_CHARACTER);
  const countedBy = builtinMethodIntrinsicFor(received, COUNTED_CHARACTERS);
  if (intrinsic === null || countedBy === null) return null;
  return {
    node,
    callee: null,
    operands: [...node.inputs],
    intrinsic,
    guardPrimitive: null,
    countedBy,
  };
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

function loweringFor(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
  frontIndexed: boolean,
): Lowering | null {
  if (node.type === IR_GENERIC_GET_PROP) return getterLowering(node, types, classes);
  if (node.type === IR_GENERIC_GET_INDEX) {
    return frontIndexed ? indexLowering(node, types, classes) : null;
  }
  if (node.type === IR_GENERIC_CALL) {
    return callLowering(node, types, classes) ?? namespaceLowering(node);
  }
  return null;
}

function allocatedArrayLength(node: CFGInstruction): CFGInstruction | null {
  if (node.type !== IR_GENERIC_GET_PROP || String(node.props.propName) !== ARRAY_LENGTH) return null;
  const receiver = node.inputs[0];
  return receiver !== undefined && receiver.type === IR_NEW_ARRAY ? receiver : null;
}

function omittedArgumentsOf(
  intrinsic: BuiltinIntrinsic,
  supplied: number,
): readonly DeclaredDefault[] {
  const { defaults, argCount } = intrinsic;
  const first = argCount - defaults.length;
  return supplied >= argCount ? [] : defaults.slice(Math.max(0, supplied - first));
}

function calledAt(
  editor: GraphEditor,
  node: CFGInstruction,
  intrinsic: BuiltinMethodIntrinsic,
  args: readonly CFGInstruction[],
  stamp: Stamp,
): CFGInstruction {
  const call = stamp(
    irCallBuiltin(intrinsic.qualifiedName, [...args], builtinMethodCallMetadata(intrinsic)),
  );
  if (irRequiresFrameState(call)) call.frameState = node.frameState;
  editor.insertBefore(node, call);
  return call;
}

function applyLowering(
  graph: CFGFunction,
  editor: GraphEditor,
  lowering: Lowering,
  reaching: DominatorTree,
  stamp: Stamp,
): void {
  const { node, callee, operands, intrinsic, guardPrimitive, countedBy } = lowering;
  const arguments_ = [...operands];
  for (const omitted of omittedArgumentsOf(intrinsic, arguments_.length)) {
    const supplied = stamp(irConstant(omitted));
    editor.insertBefore(node, supplied);
    arguments_.push(supplied);
  }
  if (guardPrimitive !== null) {
    const guard = stamp(irCheckPrimitive(arguments_[0], guardPrimitive));
    guard.frameState = node.frameState;
    editor.insertBefore(node, guard);
    arguments_[0] = guard;
  }
  if (countedBy !== undefined) {
    const receiver = arguments_[RECEIVER]!;
    arguments_[SUBSCRIPT] = boundedIndex(
      graph,
      editor,
      node,
      arguments_[SUBSCRIPT]!,
      measuredAlready(node, countedBy.qualifiedName, receiver, reaching) ??
        calledAt(editor, node, countedBy, [receiver], stamp),
      OUT_OF_RANGE,
      stamp,
    );
  }
  const replacement = calledAt(editor, node, intrinsic, arguments_, stamp);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
  if (callee !== null && callee.uses.length === 0) editor.remove(callee);
}

function blocksInDominanceOrder(graph: CFGFunction, reaching: DominatorTree): CFGBlock[] {
  const ordered = [...reaching.reversePostorder()];
  const reachable = new Set(ordered);
  for (const block of graph.blocks) if (!reachable.has(block)) ordered.push(block);
  return ordered;
}

export function lowerBuiltinMethods(
  graph: CFGFunction,
  types: TypeInference,
  target: TargetModel | null = null,
): number {
  const frontIndexed = target !== null && !target.capabilities.has(TAGGED_VALUES);
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  const reaching = new DominatorTree(graph);
  const ordered = blocksInDominanceOrder(graph, reaching);
  let discovered = graph.blocks.length;
  let count = 0;
  for (let index = 0; index < ordered.length; index++) {
    const block = ordered[index]!;
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const allocated = allocatedArrayLength(node);
      if (allocated !== null) {
        const length = stamp(irLoadArrayLength(allocated));
        editor.insertBefore(node, length);
        editor.replaceAllUses(node, length);
        editor.remove(node);
        count++;
        continue;
      }
      const lowering = loweringFor(node, types, graph.classes, frontIndexed);
      if (lowering === null) continue;
      applyLowering(graph, editor, lowering, reaching, stamp);
      count++;
    }
    for (; discovered < graph.blocks.length; discovered++) ordered.push(graph.blocks[discovered]!);
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
