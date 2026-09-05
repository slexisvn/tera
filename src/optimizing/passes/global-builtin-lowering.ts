import {
  type CFGFunction,
  type CFGInstruction,
  IR_GENERIC_CALL,
  IR_LOAD_GLOBAL,
  irCallBuiltin,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irRequiresFrameState,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  builtinMethodIntrinsicByName,
  builtinNamespaceIntrinsic,
  qualifiedMethodName,
  BUILTIN_NAMESPACE,
  NUMBER_BUILTIN,
  PARSE_FLOAT_BUILTIN,
  STRING_BUILTIN,
  WHOLE_TEXT_PROP,
  TO_STRING_MEMBER,
  type BuiltinIntrinsic,
} from "../metadata/builtin-methods.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { producedType } from "../metadata/produced-type.js";
import { TypeKind } from "../types/lattice.js";
import type { NominalTypes } from "../types/declared.js";
import {
  aotScalarOf,
  isNumericScalar,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
} from "../types/scalar.js";

const OMITTED_STRING = "";
const RENDERED_ONLY = 2;
const ONE_OPERAND = 1;
const TRUNCATED_MEMBER = "trunc";

const RENDERED_BY_SCALAR = new Map<string, string>([
  [SCALAR_INT32, qualifiedMethodName("int", TO_STRING_MEMBER)],
  [SCALAR_FLOAT64, qualifiedMethodName("float", TO_STRING_MEMBER)],
]);

function convertedValue(node: CFGInstruction, builtin: string): CFGInstruction | null {
  const callee = node.inputs[0];
  const value = node.inputs[1];
  if (callee === undefined || value === undefined || node.inputs.length !== RENDERED_ONLY) {
    return null;
  }
  if (callee.type !== IR_LOAD_GLOBAL || String(callee.props.name) !== builtin) return null;
  return value;
}

function renderedValue(node: CFGInstruction): CFGInstruction | null {
  return convertedValue(node, STRING_BUILTIN);
}

function parseLowering(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): Lowering | null {
  const value = convertedValue(node, NUMBER_BUILTIN);
  if (value === null || aotScalarOf(producedType(value, types, classes)) !== SCALAR_STRING) {
    return null;
  }
  const intrinsic = builtinGlobalIntrinsicByName(PARSE_FLOAT_BUILTIN);
  if (intrinsic === null) return null;
  return {
    node,
    callee: node.inputs[0]!,
    operands: [value],
    defaults: 0,
    intrinsic,
    wholeText: true,
  };
}

function alreadyNumeric(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): CFGInstruction | null {
  const value = convertedValue(node, NUMBER_BUILTIN);
  if (value === null) return null;
  const type = producedType(value, types, classes);
  if (type.kind === TypeKind.Boolean) return null;
  const scalar = aotScalarOf(type);
  return scalar !== null && isNumericScalar(scalar) ? value : null;
}

function countedLowering(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): Lowering | null {
  const value = convertedValue(node, NUMBER_BUILTIN);
  if (value === null || producedType(value, types, classes).kind !== TypeKind.Boolean) return null;
  const intrinsic = builtinNamespaceIntrinsic(BUILTIN_NAMESPACE, TRUNCATED_MEMBER, ONE_OPERAND);
  if (intrinsic === null) return null;
  return { node, callee: node.inputs[0]!, operands: [value], defaults: 0, intrinsic };
}

function spellsBoolean(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): CFGInstruction | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) return null;
  const value = renderedValue(node);
  if (value === null) return null;
  return producedType(value, types, classes).kind === TypeKind.Boolean ? value : null;
}

function renderLowering(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): Lowering | null {
  const value = renderedValue(node);
  if (value === null) return null;
  const callee = node.inputs[0]!;
  const type = producedType(value, types, classes);
  if (type.kind === TypeKind.Boolean) return null;
  const scalar = aotScalarOf(type);
  if (scalar === null) return null;
  const rendered = RENDERED_BY_SCALAR.get(scalar);
  if (rendered === undefined) return null;
  const intrinsic = builtinMethodIntrinsicByName(rendered);
  if (intrinsic === null) return null;
  return { node, callee, operands: [value], defaults: 0, intrinsic };
}

function alreadyText(
  node: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): CFGInstruction | null {
  const value = renderedValue(node);
  if (value === null) return null;
  return aotScalarOf(producedType(value, types, classes)) === SCALAR_STRING ? value : null;
}

function spellLater(
  editor: GraphEditor,
  node: CFGInstruction,
  value: CFGInstruction,
  stamp: Stamp,
): void {
  const callee = node.inputs[0]!;
  const member = stamp(irGenericGetProp(value, TO_STRING_MEMBER));
  const spelled = stamp(irGenericCall(member, [value]));
  spelled.props.isMethod = true;
  spelled.frameState = node.frameState;
  editor.insertBefore(node, member);
  editor.insertBefore(node, spelled);
  editor.replaceAllUses(node, spelled);
  editor.remove(node);
  editor.removeIfDead(callee);
}

type Lowering = {
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction;
  readonly operands: readonly CFGInstruction[];
  readonly defaults: number;
  readonly intrinsic: BuiltinIntrinsic;
  readonly wholeText?: boolean;
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
  const { node, callee, operands, defaults, intrinsic, wholeText } = lowering;
  const arguments_ = [...operands];
  for (let index = 0; index < defaults; index++) {
    const omitted = stamp(irConstant(OMITTED_STRING));
    editor.insertBefore(node, omitted);
    arguments_.push(omitted);
  }
  const replacement = stamp(
    irCallBuiltin(intrinsic.qualifiedName, arguments_, builtinMethodCallMetadata(intrinsic)),
  );
  if (wholeText === true) replacement.props[WHOLE_TEXT_PROP] = true;
  if (irRequiresFrameState(replacement)) replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
  editor.removeIfDead(callee);
}

export function lowerGlobalBuiltins(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      if (node.type === IR_GENERIC_CALL && node.props.isMethod !== true) {
        const kept = alreadyText(node, types, classes) ?? alreadyNumeric(node, types, classes);
        if (kept !== null) {
          const callee = node.inputs[0]!;
          editor.replaceAllUses(node, kept);
          editor.remove(node);
          editor.removeIfDead(callee);
          count++;
          continue;
        }
      }
      const spelled = spellsBoolean(node, types, classes);
      if (spelled !== null) {
        spellLater(editor, node, spelled, stamp);
        count++;
        continue;
      }
      const lowering =
        loweringFor(node) ??
        renderLowering(node, types, classes) ??
        parseLowering(node, types, classes) ??
        countedLowering(node, types, classes);
      if (lowering === null) continue;
      applyLowering(editor, lowering, stamp);
      count++;
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
