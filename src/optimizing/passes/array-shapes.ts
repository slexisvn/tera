import {
  IR_GENERIC_CALL,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_INDEX,
  IR_LOAD_ARRAY_LENGTH,
  IR_LOAD_ELEMENT,
  IR_NEW_ARRAY,
  IR_PARAMETER,
  IR_PHI,
  IR_STORE_ELEMENT,
  irArrayReserve,
  irConstant,
  irInt32Add,
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
  arrayBufferBytes,
  bufferElementOffset,
  commonAncestorOf,
  declaredTypeOf,
  ARRAY_CAPACITY_OFFSET,
  ARRAY_ELEMENT_SCALAR_PROP,
  ARRAY_ELEMENTS_OFFSET,
  ARRAY_LENGTH_OFFSET,
  BUFFER_ELEMENTS_OFFSET,
  CLASS_ID_PROP,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  INSTANCE_SIZE_PROP,
  VALUE_CLASS_PROP,
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
  scalarWidth,
  SCALAR_INT32,
  SCALAR_POINTER,
  type AotScalar,
} from "../types/scalar.js";

const COUNT_TYPE = "int";
const LENGTH_MEMBER = "length";
const PUSH_MEMBER = "push";
const ONE_ELEMENT = 1;
const EMPTY_LENGTH = 0;
const CALLEE_AND_RECEIVER = 2;

export type Stamp = (node: CFGInstruction) => CFGInstruction;

const READS_ELEMENT: ReadonlySet<string> = new Set<string>([
  IR_LOAD_ELEMENT,
  IR_GENERIC_GET_INDEX,
]);

const WRITES_ELEMENT: ReadonlySet<string> = new Set<string>([
  IR_STORE_ELEMENT,
  IR_GENERIC_SET_INDEX,
]);

export function memberCalled(node: CFGInstruction, member: string): CFGInstruction | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod !== true) return null;
  const callee = node.inputs[0];
  if (callee?.type !== IR_GENERIC_GET_PROP) return null;
  if (String(callee.props.propName) !== member) return null;
  return callee.inputs[0] === node.inputs[1] ? callee : null;
}

function pushedValue(use: CFGInstruction, array: CFGInstruction): CFGInstruction | null {
  if (memberCalled(use, PUSH_MEMBER) === null || use.inputs[1] !== array) return null;
  return use.inputs[2] ?? null;
}

function storedValues(allocation: CFGInstruction): CFGInstruction[] {
  const aliases = new Set<CFGInstruction>([allocation]);
  const pending = [allocation];
  const values = [...allocation.inputs];
  while (pending.length > 0) {
    const array = pending.pop()!;
    for (const use of array.uses) {
      if (use.type === IR_PHI && !aliases.has(use)) {
        aliases.add(use);
        pending.push(use);
        continue;
      }
      const pushed = pushedValue(use, array);
      if (pushed !== null) {
        values.push(pushed);
        continue;
      }
      if (!WRITES_ELEMENT.has(use.type) || !aliases.has(use.inputs[0]!)) continue;
      values.push(use.inputs[2]!);
    }
  }
  return values;
}

function classOfValue(
  value: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  const carried = value.props[VALUE_CLASS_PROP];
  if (typeof carried === "number") return classes.shapeById(carried);
  const type = types.typeOf(value);
  if (type.kind !== TypeKind.Object || typeof type.map !== "number") return null;
  return classes.shapeById(type.map);
}

function valueTypeOf(
  value: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): LatticeType {
  const shape = classOfValue(value, classes, types);
  return shape === null ? types.typeOf(value) : objectType(shape.id);
}

function sharedClass(
  values: readonly CFGInstruction[],
  classes: ClassTable,
  types: TypeInference,
): LatticeType | null {
  const shapes: ClassShape[] = [];
  for (const value of values) {
    const shape = classOfValue(value, classes, types);
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
    const stored = valueTypeOf(value, classes, types);
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

export interface ArrayModel {
  readonly shape: ClassShape;
  readonly buffer: ClassShape;
  readonly element: AotScalar;
  readonly declaredType: string;
}

function modelOf(shape: ClassShape | null, classes: ClassTable): ArrayModel | null {
  if (shape === null) return null;
  const layout = classes.arrayLayoutOf(shape);
  return layout === null ? null : { shape, ...layout };
}

function shapedArray(array: CFGInstruction, classes: ClassTable): ArrayModel | null {
  const carried = array.props[VALUE_CLASS_PROP];
  return modelOf(typeof carried === "number" ? classes.shapeById(carried) : null, classes);
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
  return carried === null ? null : modelOf(classes.defineArray(carried), classes);
}

export function arrayModelOf(
  array: CFGInstruction | undefined,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ArrayModel | null {
  if (array === undefined) return null;
  return shapedArray(array, classes) ?? receivedArray(array, graph, classes, types);
}

export function arrayElementShapeOf(
  array: CFGInstruction | undefined,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  const model = arrayModelOf(array, graph, classes, types);
  return model === null ? null : classes.shapeOf(model.declaredType);
}

function allocateObject(
  editor: GraphEditor,
  before: CFGInstruction,
  shape: ClassShape,
  bytes: number,
  stamp: Stamp,
): CFGInstruction {
  const allocation = stamp(irNewObject());
  allocation.props[CLASS_ID_PROP] = shape.id;
  allocation.props[INSTANCE_SIZE_PROP] = bytes;
  allocation.props[VALUE_CLASS_PROP] = shape.id;
  allocation.frameState = before.frameState;
  editor.insertBefore(before, allocation);
  return allocation;
}

export function storeCount(
  editor: GraphEditor,
  before: CFGInstruction,
  array: CFGInstruction,
  offset: number,
  value: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): CFGInstruction {
  const store = stamp(irStoreField(array, offset, value));
  store.props[CLASS_ID_PROP] = model.shape.id;
  store.props[FIELD_SCALAR_PROP] = SCALAR_INT32;
  store.props[FIELD_TYPE_PROP] = COUNT_TYPE;
  store.frameState = before.frameState;
  editor.insertBefore(before, store);
  return store;
}

export function loadCount(
  editor: GraphEditor,
  before: CFGInstruction,
  array: CFGInstruction,
  offset: number,
  model: ArrayModel,
  stamp: Stamp,
): CFGInstruction {
  const load = stamp(irLoadField(array, offset));
  load.props[CLASS_ID_PROP] = model.shape.id;
  load.props[FIELD_SCALAR_PROP] = SCALAR_INT32;
  load.props[FIELD_TYPE_PROP] = COUNT_TYPE;
  load.frameState = before.frameState;
  editor.insertBefore(before, load);
  return load;
}

export function loadBuffer(
  editor: GraphEditor,
  before: CFGInstruction,
  array: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): CFGInstruction {
  const load = stamp(irLoadField(array, ARRAY_ELEMENTS_OFFSET));
  load.props[CLASS_ID_PROP] = model.shape.id;
  load.props[FIELD_SCALAR_PROP] = SCALAR_POINTER;
  load.props[FIELD_TYPE_PROP] = model.buffer.name;
  load.props[VALUE_CLASS_PROP] = model.buffer.id;
  load.frameState = before.frameState;
  editor.insertBefore(before, load);
  return load;
}

export function constantAt(
  editor: GraphEditor,
  before: CFGInstruction,
  value: number,
  stamp: Stamp,
): CFGInstruction {
  const constant = stamp(irConstant(value));
  editor.insertBefore(before, constant);
  return constant;
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
  const model = modelOf(classes.defineArray(carried), classes);
  if (model === null) return false;
  for (const value of node.inputs) {
    const stored = aotScalarOf(valueTypeOf(value, classes, types));
    if (stored === null || !fits(stored, model.element)) return false;
  }

  const count = node.inputs.length;
  const buffer = allocateObject(
    editor,
    node,
    model.buffer,
    arrayBufferBytes(model.element, count),
    stamp,
  );
  node.inputs.forEach((value, index) => {
    const store = stamp(
      irStoreField(buffer, bufferElementOffset(model.element, index), value, String(index)),
    );
    store.props[CLASS_ID_PROP] = model.buffer.id;
    store.props[FIELD_SCALAR_PROP] = model.element;
    store.props[FIELD_TYPE_PROP] = model.declaredType;
    editor.insertBefore(node, store);
  });

  const array = allocateObject(editor, node, model.shape, model.shape.size, stamp);
  const counted = constantAt(editor, node, count, stamp);
  storeCount(editor, node, array, ARRAY_LENGTH_OFFSET, counted, model, stamp);
  storeCount(editor, node, array, ARRAY_CAPACITY_OFFSET, counted, model, stamp);
  const elements = stamp(irStoreField(array, ARRAY_ELEMENTS_OFFSET, buffer));
  elements.props[CLASS_ID_PROP] = model.shape.id;
  elements.props[FIELD_SCALAR_PROP] = SCALAR_POINTER;
  elements.props[FIELD_TYPE_PROP] = model.buffer.name;
  editor.insertBefore(node, elements);

  editor.replaceAllUses(node, array);
  editor.remove(node);
  return true;
}

function replaceLength(
  editor: GraphEditor,
  node: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): void {
  const length = loadCount(editor, node, node.inputs[0]!, ARRAY_LENGTH_OFFSET, model, stamp);
  editor.replaceAllUses(node, length);
  editor.remove(node);
}

export function describeElement(
  access: CFGInstruction,
  model: ArrayModel,
): CFGInstruction {
  access.props[ARRAY_ELEMENT_SCALAR_PROP] = model.element;
  access.props.offset = BUFFER_ELEMENTS_OFFSET;
  access.props[CLASS_ID_PROP] = model.buffer.id;
  access.props[FIELD_SCALAR_PROP] = model.element;
  access.props[FIELD_TYPE_PROP] = model.declaredType;
  return access;
}

export function elementAccess(
  editor: GraphEditor,
  before: CFGInstruction,
  access: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): CFGInstruction {
  const stamped = describeElement(stamp(access), model);
  stamped.frameState = before.frameState;
  editor.insertBefore(before, stamped);
  return stamped;
}

function replaceElement(
  editor: GraphEditor,
  node: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): void {
  const buffer = loadBuffer(editor, node, node.inputs[0]!, model, stamp);
  const index = node.inputs[1]!;
  const access = elementAccess(
    editor,
    node,
    READS_ELEMENT.has(node.type)
      ? irLoadElement(buffer, index)
      : irStoreElement(buffer, index, node.inputs[2]!),
    model,
    stamp,
  );
  editor.replaceAllUses(node, access);
  editor.remove(node);
}

export function arrayModelForElement(
  classes: ClassTable,
  element: LatticeType,
): ArrayModel | null {
  return modelOf(classes.defineArray(element), classes);
}

export function emptyArray(
  editor: GraphEditor,
  before: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): CFGInstruction {
  const buffer = allocateObject(
    editor,
    before,
    model.buffer,
    arrayBufferBytes(model.element, EMPTY_LENGTH),
    stamp,
  );
  const array = allocateObject(editor, before, model.shape, model.shape.size, stamp);
  const empty = constantAt(editor, before, EMPTY_LENGTH, stamp);
  storeCount(editor, before, array, ARRAY_LENGTH_OFFSET, empty, model, stamp);
  storeCount(editor, before, array, ARRAY_CAPACITY_OFFSET, empty, model, stamp);
  const elements = stamp(irStoreField(array, ARRAY_ELEMENTS_OFFSET, buffer));
  elements.props[CLASS_ID_PROP] = model.shape.id;
  elements.props[FIELD_SCALAR_PROP] = SCALAR_POINTER;
  elements.props[FIELD_TYPE_PROP] = model.buffer.name;
  editor.insertBefore(before, elements);
  return array;
}

export function pushElement(
  editor: GraphEditor,
  before: CFGInstruction,
  array: CFGInstruction,
  value: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): CFGInstruction {
  const buffer = stamp(
    irArrayReserve(array, model.buffer.id, scalarWidth(model.element)),
  );
  buffer.props[VALUE_CLASS_PROP] = model.buffer.id;
  buffer.frameState = before.frameState;
  editor.insertBefore(before, buffer);

  const length = loadCount(editor, before, array, ARRAY_LENGTH_OFFSET, model, stamp);
  elementAccess(editor, before, irStoreElement(buffer, length, value), model, stamp);

  const step = constantAt(editor, before, ONE_ELEMENT, stamp);
  const grown = stamp(irInt32Add(length, step));
  grown.props.noOverflow = true;
  editor.insertBefore(before, grown);
  storeCount(editor, before, array, ARRAY_LENGTH_OFFSET, grown, model, stamp);
  return grown;
}

function replacePush(
  editor: GraphEditor,
  node: CFGInstruction,
  callee: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): void {
  const grown = pushElement(editor, node, node.inputs[1]!, node.inputs[2]!, model, stamp);
  editor.replaceAllUses(node, grown);
  editor.remove(node);
  if (callee.uses.length === 0) editor.remove(callee);
}

function readsLength(node: CFGInstruction): boolean {
  if (node.type === IR_LOAD_ARRAY_LENGTH) return true;
  return node.type === IR_GENERIC_GET_PROP && String(node.props.propName) === LENGTH_MEMBER;
}

export function shapeArrayAllocations(graph: CFGFunction, types: TypeInference): number {
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
  return changed;
}

export function lowerArrayAccess(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let changed = 0;

  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const push = memberCalled(node, PUSH_MEMBER);
      if (push !== null && node.inputs.length - CALLEE_AND_RECEIVER === ONE_ELEMENT) {
        const model = arrayModelOf(node.inputs[1], graph, classes, types);
        if (model === null) continue;
        replacePush(editor, node, push, model, stamp);
        changed++;
        continue;
      }
      const reads = readsLength(node);
      if (!reads && !READS_ELEMENT.has(node.type) && !WRITES_ELEMENT.has(node.type)) continue;
      const model = arrayModelOf(node.inputs[0], graph, classes, types);
      if (model === null) continue;
      changed++;
      if (reads) replaceLength(editor, node, model, stamp);
      else replaceElement(editor, node, model, stamp);
    }
  }
  if (changed > 0) graph.rebuildUses();
  return changed;
}
