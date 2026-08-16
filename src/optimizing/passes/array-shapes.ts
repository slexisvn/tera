import {
  IR_CONSTANT,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_INDEX,
  IR_LOAD_ARRAY_LENGTH,
  IR_LOAD_ELEMENT,
  IR_NEW_ARRAY,
  IR_PARAMETER,
  IR_PHI,
  IR_STORE_ELEMENT,
  irConstant,
  irLoadElement,
  irLoadField,
  irNewObject,
  irStoreElement,
  irStoreField,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  arrayLayoutOf,
  arrayElementOffset,
  commonAncestorOf,
  declaredTypeOf,
  ARRAY_LENGTH_OFFSET,
  type ClassShape,
  type ClassTable,
} from "../metadata/class-table.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { nominalLatticeType } from "../types/declared.js";
import { arrayElementType } from "../../frontend/checker/type-system.js";
import { latticeFromElementsKind } from "../types/elements.js";
import {
  doubleType,
  joinTypes,
  neverType,
  objectType,
  TypeKind,
  type LatticeType,
} from "../types/lattice.js";
import {
  aotScalarOf,
  isNumericScalar,
  isReferenceScalar,
  isStorableScalar,
  SCALAR_INT32,
  type AotScalar,
} from "../types/scalar.js";
import {
  ARRAY_ELEMENT_SCALAR_PROP,
  CLASS_ID_PROP,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  INSTANCE_SIZE_PROP,
  VALUE_CLASS_PROP,
} from "./class-member-lowering.js";

const COUNT_TYPE = "int";
const LENGTH_MEMBER = "length";

type Stamp = (node: CFGInstruction) => CFGInstruction;

const READS_ELEMENT: ReadonlySet<string> = new Set<string>([
  IR_LOAD_ELEMENT,
  IR_GENERIC_GET_INDEX,
]);

const WRITES_ELEMENT: ReadonlySet<string> = new Set<string>([
  IR_STORE_ELEMENT,
  IR_GENERIC_SET_INDEX,
]);

function storedValues(allocation: CFGInstruction): CFGInstruction[] {
  const aliases = new Set<CFGInstruction>([allocation]);
  const pending = [allocation];
  const values = [...allocation.inputs];
  while (pending.length > 0) {
    for (const use of pending.pop()!.uses) {
      if (use.type === IR_PHI && !aliases.has(use)) {
        aliases.add(use);
        pending.push(use);
        continue;
      }
      if (!WRITES_ELEMENT.has(use.type) || !aliases.has(use.inputs[0]!)) continue;
      values.push(use.inputs[2]!);
    }
  }
  return values;
}

function sharedClass(
  values: readonly CFGInstruction[],
  classes: ClassTable,
  types: TypeInference,
): LatticeType | null {
  const shapes: ClassShape[] = [];
  for (const value of values) {
    const type = types.typeOf(value);
    if (type.kind !== TypeKind.Object || typeof type.map !== "number") return null;
    const shape = classes.shapeById(type.map);
    if (shape === null) return null;
    shapes.push(shape);
  }
  const common = commonAncestorOf(classes, shapes);
  return common === null ? null : objectType(common.id);
}

function elementTypeOf(
  allocation: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): LatticeType | null {
  const array = types.typeOf(allocation);
  if (array.kind !== TypeKind.Array) return null;
  const declared = latticeFromElementsKind(array.elementsKind);
  const values = storedValues(allocation);
  let joined: LatticeType = declared.kind === TypeKind.Any ? neverType() : declared;
  for (const value of values) {
    const stored = types.typeOf(value);
    if (isStorableScalar(aotScalarOf(stored)) === null) return null;
    joined = joinTypes(joined, stored)!;
  }
  if (declaredTypeOf(joined, classes) !== null) return joined;
  return sharedClass(values, classes, types) ?? doubleType();
}

function fits(value: AotScalar, element: AotScalar): boolean {
  return isReferenceScalar(element) || isReferenceScalar(value)
    ? value === element
    : isNumericScalar(value);
}

function constantIndex(node: CFGInstruction): number | null {
  const index = node.inputs[1];
  if (index?.type !== IR_CONSTANT) return null;
  const value = index.props.value;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

interface ArrayModel {
  readonly shape: ClassShape | null;
  readonly element: AotScalar;
  readonly declaredType: string;
  readonly length: number | null;
}

function shapedArray(array: CFGInstruction, classes: ClassTable): ArrayModel | null {
  const carried = array.props[VALUE_CLASS_PROP];
  const shape = typeof carried === "number" ? classes.shapeById(carried) : null;
  const layout = shape === null ? null : arrayLayoutOf(shape);
  return layout === null ? null : { shape, ...layout };
}

function declaredArrayOf(array: CFGInstruction, graph: CFGFunction): string | null {
  const field = array.props[FIELD_TYPE_PROP];
  if (typeof field === "string") return field;
  if (array.type === IR_PARAMETER) {
    return graph.declaredSignature?.params[Number(array.props.index)] ?? null;
  }
  const target = array.props.target as
    | { declaredSignature?: { returns?: string | null } | null }
    | undefined;
  return target?.declaredSignature?.returns ?? null;
}

function receivedElement(
  array: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): LatticeType | null {
  const type = types.typeOf(array);
  if (type.kind !== TypeKind.Array) return null;
  const carried = latticeFromElementsKind(type.elementsKind);
  if (declaredTypeOf(carried, classes) !== null) return carried;
  const declared = declaredArrayOf(array, graph);
  const element = declared === null ? null : arrayElementType(declared);
  return element === null ? null : nominalLatticeType(element, classes);
}

function receivedArray(
  array: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ArrayModel | null {
  const carried = receivedElement(array, graph, classes, types);
  if (carried === null) return null;
  const element = isStorableScalar(aotScalarOf(carried));
  const declaredType = declaredTypeOf(carried, classes);
  if (element === null || declaredType === null) return null;
  return { shape: null, element, declaredType, length: null };
}

function allocate(
  editor: GraphEditor,
  node: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
  stamp: Stamp,
): boolean {
  const carried = elementTypeOf(node, classes, types);
  if (carried === null) return false;
  const length = node.inputs.length;
  const shape = classes.defineArray(carried, length);
  if (shape === null) return false;
  const element = arrayLayoutOf(shape)!.element;
  for (const value of node.inputs) {
    const stored = aotScalarOf(types.typeOf(value));
    if (stored === null || !fits(stored, element)) return false;
  }

  const allocation = stamp(irNewObject());
  allocation.props[CLASS_ID_PROP] = shape.id;
  allocation.props[INSTANCE_SIZE_PROP] = shape.size;
  allocation.props[VALUE_CLASS_PROP] = shape.id;
  allocation.frameState = node.frameState;
  editor.insertBefore(node, allocation);

  for (const field of shape.fields.values()) {
    if (field.scalar !== SCALAR_INT32 || field.declaredType !== COUNT_TYPE) continue;
    const count = stamp(irConstant(length));
    editor.insertBefore(node, count);
    const store = stamp(irStoreField(allocation, field.offset, count, field.name));
    store.props[CLASS_ID_PROP] = shape.id;
    store.props[FIELD_SCALAR_PROP] = SCALAR_INT32;
    store.props[FIELD_TYPE_PROP] = COUNT_TYPE;
    editor.insertBefore(node, store);
  }

  node.inputs.forEach((value, index) => {
    const store = stamp(
      irStoreField(allocation, arrayElementOffset(element, index), value, String(index)),
    );
    store.props[CLASS_ID_PROP] = shape.id;
    store.props[FIELD_SCALAR_PROP] = element;
    editor.insertBefore(node, store);
  });

  editor.replaceAllUses(node, allocation);
  editor.remove(node);
  return true;
}

function loadCount(
  editor: GraphEditor,
  node: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): void {
  const array = node.inputs[0]!;
  const replacement =
    model.length === null
      ? stamp(irLoadField(array, ARRAY_LENGTH_OFFSET))
      : stamp(irConstant(model.length));
  if (model.length === null) {
    if (model.shape !== null) replacement.props[CLASS_ID_PROP] = model.shape.id;
    replacement.props[FIELD_SCALAR_PROP] = SCALAR_INT32;
    replacement.props[FIELD_TYPE_PROP] = COUNT_TYPE;
  }
  replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
}

function accessElement(
  editor: GraphEditor,
  node: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): void {
  const array = node.inputs[0]!;
  const reads = READS_ELEMENT.has(node.type);
  const at = constantIndex(node);
  const known = at !== null && model.length !== null && at < model.length;
  const offset = known ? arrayElementOffset(model.element, at!) : 0;
  const replacement = known
    ? stamp(
        reads
          ? irLoadField(array, offset)
          : irStoreField(array, offset, node.inputs[2]!, String(at)),
      )
    : stamp(
        reads
          ? irLoadElement(array, node.inputs[1]!)
          : irStoreElement(array, node.inputs[1]!, node.inputs[2]!),
      );
  if (!known) {
    replacement.props[ARRAY_ELEMENT_SCALAR_PROP] = model.element;
    replacement.props.offset = arrayElementOffset(model.element, 0);
  }
  if (model.shape !== null) replacement.props[CLASS_ID_PROP] = model.shape.id;
  replacement.props[FIELD_SCALAR_PROP] = model.element;
  replacement.props[FIELD_TYPE_PROP] = model.declaredType;
  replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
}

function readsLength(node: CFGInstruction): boolean {
  if (node.type === IR_LOAD_ARRAY_LENGTH) return true;
  return node.type === IR_GENERIC_GET_PROP && String(node.props.propName) === LENGTH_MEMBER;
}

export function shapeArrays(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let changed = 0;

  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.type !== IR_NEW_ARRAY || node.block !== block) continue;
      if (allocate(editor, node, classes, types, stamp)) changed++;
    }
  }
  if (changed > 0) graph.rebuildUses();

  let reached = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const array = node.inputs[0];
      if (array === undefined) continue;
      const touches =
        readsLength(node) || READS_ELEMENT.has(node.type) || WRITES_ELEMENT.has(node.type);
      if (!touches) continue;
      const model = shapedArray(array, classes) ?? receivedArray(array, graph, classes, types);
      if (model === null) continue;
      reached++;
      if (readsLength(node)) loadCount(editor, node, model, stamp);
      else accessElement(editor, node, model, stamp);
    }
  }
  if (reached > 0) graph.rebuildUses();
  return changed + reached;
}
