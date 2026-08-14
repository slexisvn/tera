import {
  type CFGFunction,
  type CFGInstruction,
  IR_GENERIC_CALL,
  IR_LOAD_GLOBAL,
  irCallBuiltin,
  irConstant,
  irRequiresFrameState,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  type BuiltinIntrinsic,
} from "../metadata/builtin-methods.js";

const OMITTED_STRING = "";

type Lowering = {
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction;
  readonly operands: readonly CFGInstruction[];
  readonly defaults: number;
  readonly intrinsic: BuiltinIntrinsic;
};

function loweringFor(node: CFGInstruction): Lowering | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) return null;
  const callee = node.inputs[0];
  if (callee === undefined || callee.type !== IR_LOAD_GLOBAL) return null;
  const intrinsic = builtinGlobalIntrinsicByName(String(callee.props.name));
  if (intrinsic === null) return null;
  const operands = node.inputs.slice(1);
  const defaults = Math.max(0, intrinsic.requiredArgCount - operands.length);
  return { node, callee, operands, defaults, intrinsic };
}

type Stamp = (node: CFGInstruction) => CFGInstruction;

function applyLowering(editor: GraphEditor, lowering: Lowering, stamp: Stamp): void {
  const { node, callee, operands, defaults, intrinsic } = lowering;
  const arguments_ = [...operands];
  for (let index = 0; index < defaults; index++) {
    const omitted = stamp(irConstant(OMITTED_STRING));
    editor.insertBefore(node, omitted);
    arguments_.push(omitted);
  }
  const replacement = stamp(
    irCallBuiltin(intrinsic.qualifiedName, arguments_, builtinMethodCallMetadata(intrinsic)),
  );
  if (irRequiresFrameState(replacement)) replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
  if (callee.uses.length === 0) editor.remove(callee);
}

export function lowerGlobalBuiltins(graph: CFGFunction): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const lowering = loweringFor(node);
      if (lowering === null) continue;
      applyLowering(editor, lowering, stamp);
      count++;
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
