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
  builtinMethodIntrinsicByName,
  qualifiedMethodName,
  STRING_BUILTIN,
  TO_STRING_MEMBER,
  type BuiltinIntrinsic,
} from "../metadata/builtin-methods.js";
import type { TypeInference } from "../analyses/type-inference.js";
import {
  aotScalarOf,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
} from "../types/scalar.js";

const OMITTED_STRING = "";

const RENDERED_BY_SCALAR = new Map<string, string>([
  [SCALAR_INT32, qualifiedMethodName("int", TO_STRING_MEMBER)],
  [SCALAR_FLOAT64, qualifiedMethodName("float", TO_STRING_MEMBER)],
]);

function renderLowering(node: CFGInstruction, types: TypeInference): Lowering | null {
  const callee = node.inputs[0];
  const value = node.inputs[1];
  if (callee === undefined || value === undefined || node.inputs.length !== 2) return null;
  if (callee.type !== IR_LOAD_GLOBAL || String(callee.props.name) !== STRING_BUILTIN) return null;
  const scalar = aotScalarOf(types.typeOf(value));
  if (scalar === null) return null;
  const rendered = RENDERED_BY_SCALAR.get(scalar);
  if (rendered === undefined) return null;
  const intrinsic = builtinMethodIntrinsicByName(rendered);
  if (intrinsic === null) return null;
  return { node, callee, operands: [value], defaults: 0, intrinsic };
}

function alreadyText(node: CFGInstruction, types: TypeInference): CFGInstruction | null {
  const callee = node.inputs[0];
  const value = node.inputs[1];
  if (callee === undefined || value === undefined || node.inputs.length !== 2) return null;
  if (callee.type !== IR_LOAD_GLOBAL || String(callee.props.name) !== STRING_BUILTIN) return null;
  return aotScalarOf(types.typeOf(value)) === SCALAR_STRING ? value : null;
}

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

export function lowerGlobalBuiltins(graph: CFGFunction, types: TypeInference): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      if (node.type === IR_GENERIC_CALL && node.props.isMethod !== true) {
        const text = alreadyText(node, types);
        if (text !== null) {
          const callee = node.inputs[0]!;
          editor.replaceAllUses(node, text);
          editor.remove(node);
          if (callee.uses.length === 0) editor.remove(callee);
          count++;
          continue;
        }
      }
      const lowering = loweringFor(node) ?? renderLowering(node, types);
      if (lowering === null) continue;
      applyLowering(editor, lowering, stamp);
      count++;
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
