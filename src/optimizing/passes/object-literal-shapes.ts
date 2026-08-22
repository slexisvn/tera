import {
  irGenericGetProp,
  irGenericSetProp,
  IR_CALL_KNOWN_FUNCTION,
  IR_COPY_PROPERTIES,
  IR_GENERIC_CALL,
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
  INSTANCE_SIZE_PROP,
  isLiteralShapeName,
  literalShapeSurface,
  shapeForDeclared,
  VALUE_CLASS_PROP,
  type ClassShape,
  type ClassTable,
  type LiteralField,
} from "../metadata/class-table.js";
import { calleeDeclaredSignature } from "../analyses/aot-legality.js";
import type { DeclaredSignature } from "../types/signature.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";
import { nominalLatticeType } from "../types/declared.js";
import { arrayElementNameOf } from "./array-shapes.js";

const ANY_TYPE = "any";
const CALLEE_INPUT = 1;

function storedTypeName(
  stored: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  if (types.typeOf(stored).kind !== TypeKind.Array) {
    return declaredTypeOf(types.typeOf(stored), classes);
  }
  const element = arrayElementNameOf(stored, graph, classes, types);
  if (element === null) return null;
  return classes.defineArray(nominalLatticeType(element, classes))?.name ?? null;
}

function initializerOf(
  allocation: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): readonly LiteralField[] | null {
  const block = allocation.block;
  if (block === null) return null;
  const fields: LiteralField[] = [];
  const named = new Map<string, string>();
  for (const use of allocation.uses) {
    if (use.type !== IR_GENERIC_SET_PROP || use.inputs[0] !== allocation) continue;
    const name = String(use.props.propName);
    const stored = use.inputs[1];
    if (stored === undefined) return null;
    const declaredType = storedTypeName(stored, graph, classes, types);
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

function argumentIndexOf(call: CFGInstruction, argument: CFGInstruction): number {
  if (call.type === IR_CALL_KNOWN_FUNCTION) return call.inputs.indexOf(argument);
  if (call.type !== IR_GENERIC_CALL || call.props.isMethod === true) return -1;
  const at = call.inputs.indexOf(argument);
  return at < CALLEE_INPUT ? -1 : at - CALLEE_INPUT;
}

export type CalleeSignatures = (call: CFGInstruction) => DeclaredSignature | null;

function passedAs(
  allocation: CFGInstruction,
  use: CFGInstruction,
  classes: ClassTable,
  signatureOf: CalleeSignatures,
): ClassShape | null {
  const at = argumentIndexOf(use, allocation);
  if (at < 0) return null;
  return shapeForDeclared(classes, signatureOf(use)?.params[at] ?? null);
}

function holdsExactly(shape: ClassShape, fields: readonly LiteralField[]): boolean {
  if (shape.fields.size !== fields.length) return false;
  return fields.every((field) => shape.fields.has(field.name));
}

function declaredShapeOf(
  allocation: CFGInstruction,
  fields: readonly LiteralField[],
  classes: ClassTable,
  signatureOf: CalleeSignatures,
): ClassShape | null {
  let agreed: ClassShape | null = null;
  for (const use of allocation.uses) {
    const asked = passedAs(allocation, use, classes, signatureOf);
    if (asked === null) continue;
    if (agreed !== null && agreed !== asked) return null;
    agreed = asked;
  }
  return agreed !== null && holdsExactly(agreed, fields) ? agreed : null;
}

function shapeHeldBy(
  value: CFGInstruction | undefined,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  if (value === undefined) return null;
  const carried = value.props[VALUE_CLASS_PROP];
  if (typeof carried === "number") return classes.shapeById(carried);
  const type = types.typeOf(value);
  if (type.kind !== TypeKind.Object || typeof type.map !== "number") return null;
  return classes.shapeById(type.map);
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
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.type !== IR_NEW_OBJECT) continue;
      if (node.props[CLASS_ID_PROP] !== undefined) continue;
      if (!spreadFieldsInto(node, classes, types, editor, stamp)) continue;
      const fields = initializerOf(node, graph, classes, types);
      if (fields === null) continue;
      const shape =
        declaredShapeOf(node, fields, classes, signatureOf) ??
        classes.defineSynthetic(literalShapeSurface(fields));
      if (shape.fields.size !== fields.length) continue;
      node.props[CLASS_ID_PROP] = shape.id;
      node.props[INSTANCE_SIZE_PROP] = shape.size;
      node.props[VALUE_CLASS_PROP] = shape.id;
      shaped++;
    }
  }
  return shaped;
}
