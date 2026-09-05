import {
  irGenericGetProp,
  irGenericSetProp,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_COPY_PROPERTIES,
  IR_GENERIC_SET_PROP,
  IR_NEW_OBJECT,
  IR_RETURN,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  CLASS_ID_PROP,
  declaredTypeOf,
  heldTypeOf,
  INSTANCE_SIZE_PROP,
  isLiteralShapeName,
  literalShapeSurface,
  shapeForDeclared,
  VALUE_CLASS_PROP,
  type ClassShape,
  type ClassTable,
  type LiteralField,
} from "../metadata/class-table.js";
import { codeSymbolOf } from "../analyses/aot-legality.js";
import {
  calleeDeclaredSignature,
  declaredTypeAt,
  shapeHeldBy,
  type CalleeSignatures,
} from "../metadata/call-signatures.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import { functionTypeTextOf } from "../types/signature.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";
import { nominalLatticeType } from "../types/declared.js";
import { arrayElementNameOf, producedTypeName } from "./array-shapes.js";

const ANY_TYPE = "any";

function functionValueTypeOf(stored: CFGInstruction, graph: CFGFunction): string | null {
  const named = codeSymbolOf(stored);
  if (named === null) return null;
  const compiled =
    stored.type === IR_CONSTANT ? compiledFunctionConstant(stored.props.value) : null;
  return (
    functionTypeTextOf(compiled?.declaredSignature) ??
    functionTypeTextOf(graph.calleeSignatures?.get(named))
  );
}

export function heldTypeNameOf(
  stored: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  const code = functionValueTypeOf(stored, graph);
  if (code !== null) return code;
  if (types.typeOf(stored).kind !== TypeKind.Array) {
    return (
      shapeHeldBy(stored, classes, types)?.name ??
      heldTypeOf(types.typeOf(stored), classes) ??
      producedTypeName(stored, graph, classes, types)
    );
  }
  const element = arrayElementNameOf(stored, graph, classes, types);
  if (element === null) return null;
  return classes.defineArray(nominalLatticeType(element, classes))?.name ?? null;
}

function writtenNamesOf(allocation: CFGInstruction): readonly string[] | null {
  if (allocation.block === null) return null;
  const written = new Set<string>();
  for (const use of allocation.uses) {
    if (use.type !== IR_GENERIC_SET_PROP || use.inputs[0] !== allocation) continue;
    if (use.inputs[1] === undefined) return null;
    written.add(String(use.props.propName));
  }
  return written.size === 0 ? null : [...written];
}

function initializerOf(
  allocation: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): readonly LiteralField[] | null {
  const fields: LiteralField[] = [];
  const named = new Map<string, string>();
  for (const use of allocation.uses) {
    if (use.type !== IR_GENERIC_SET_PROP || use.inputs[0] !== allocation) continue;
    const name = String(use.props.propName);
    const stored = use.inputs[1];
    if (stored === undefined) return null;
    const declaredType = heldTypeNameOf(stored, graph, classes, types);
    if (declaredType === null) return null;
    const seen = named.get(name);
    if (seen !== undefined) {
      if (seen !== declaredType) return null;
      continue;
    }
    named.set(name, declaredType);
    fields.push({ name, declaredType });
  }
  return fields.length === 0 ? null : fields;
}

function inferredShapeOf(
  allocation: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  const fields = initializerOf(allocation, graph, classes, types);
  return fields === null ? null : classes.defineSynthetic(literalShapeSurface(fields));
}

export function literalShapeNameOf(
  allocation: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  if (allocation.type !== IR_NEW_OBJECT) return null;
  return inferredShapeOf(allocation, graph, classes, types)?.name ?? null;
}

export function literalReturnShapeOf(graph: CFGFunction): string | null {
  const declared = graph.declaredSignature?.returns ?? null;
  if (declared !== null && declared !== ANY_TYPE) return null;
  let shaped: string | null = null;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_RETURN) continue;
      const returned = node.inputs[0];
      const carried = returned?.props[VALUE_CLASS_PROP];
      const name =
        typeof carried === "number" ? graph.classes?.shapeById(carried)?.name ?? null : null;
      if (name === null || !isLiteralShapeName(name)) return null;
      if (shaped !== null && shaped !== name) return null;
      shaped = name;
    }
  }
  return shaped;
}

function holdsExactly(shape: ClassShape, written: readonly string[]): boolean {
  if (shape.fields.size !== written.length) return false;
  return written.every((name) => shape.fields.has(name));
}

const ELEMENT_ARGUMENT = 2;
const RECEIVER_INPUT = 1;
const TAKES_AN_ELEMENT: ReadonlySet<string> = new Set<string>(["push", "unshift"]);

function heldElementAt(
  use: CFGInstruction,
  at: number,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  if (use.type !== IR_GENERIC_CALL || at !== ELEMENT_ARGUMENT) return null;
  const callee = use.inputs[0];
  if (callee?.type !== IR_GENERIC_GET_PROP) return null;
  if (!TAKES_AN_ELEMENT.has(String(callee.props.propName))) return null;
  return arrayElementNameOf(use.inputs[RECEIVER_INPUT], graph, classes, types);
}

function declaredShapeOf(
  allocation: CFGInstruction,
  written: readonly string[],
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  signatureOf: CalleeSignatures,
): ClassShape | null {
  let agreed: ClassShape | null = null;
  for (const use of allocation.uses) {
    for (const [at, input] of use.inputs.entries()) {
      if (input !== allocation) continue;
      const asked = shapeForDeclared(
        classes,
        declaredTypeAt(use, at, graph, classes, types, signatureOf) ??
          heldElementAt(use, at, graph, classes, types),
      );
      if (asked === null) continue;
      if (agreed !== null && agreed !== asked) return null;
      agreed = asked;
    }
  }
  return agreed !== null && holdsExactly(agreed, written) ? agreed : null;
}

function spreadFieldsInto(
  allocation: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
  editor: GraphEditor,
  stamp: (node: CFGInstruction) => CFGInstruction,
): boolean {
  for (const use of [...allocation.uses]) {
    if (use.type !== IR_COPY_PROPERTIES || use.inputs[0] !== allocation) continue;
    const source = use.inputs[1];
    const shape = shapeHeldBy(source, classes, types);
    if (shape === null || source === undefined) return false;
    for (const name of shape.fields.keys()) {
      const read = stamp(irGenericGetProp(source, name));
      editor.insertBefore(use, read);
      editor.insertBefore(use, stamp(irGenericSetProp(allocation, name, read)));
    }
    editor.remove(use);
  }
  return true;
}

function adoptShape(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  signatureOf: CalleeSignatures,
  editor: GraphEditor,
  stamp: (node: CFGInstruction) => CFGInstruction,
): boolean {
  if (node.type !== IR_NEW_OBJECT || node.props[CLASS_ID_PROP] !== undefined) return false;
  if (!spreadFieldsInto(node, classes, types, editor, stamp)) return false;
  const written = writtenNamesOf(node);
  if (written === null) return false;
  const shape =
    declaredShapeOf(node, written, graph, classes, types, signatureOf) ??
    inferredShapeOf(node, graph, classes, types);
  if (shape === null || !holdsExactly(shape, written)) return false;
  node.props[CLASS_ID_PROP] = shape.id;
  node.props[INSTANCE_SIZE_PROP] = shape.size;
  node.props[VALUE_CLASS_PROP] = shape.id;
  return true;
}

export function shapeObjectLiterals(
  graph: CFGFunction,
  types: TypeInference,
  signatureOf: CalleeSignatures = calleeDeclaredSignature,
): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let shaped = 0;
  let adopting = true;
  while (adopting) {
    adopting = false;
    for (const block of graph.blocks) {
      for (const node of [...block.nodes]) {
        if (!adoptShape(node, graph, classes, types, signatureOf, editor, stamp)) continue;
        adopting = true;
        shaped++;
      }
    }
  }
  return shaped;
}
