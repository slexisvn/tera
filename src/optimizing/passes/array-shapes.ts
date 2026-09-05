import {
  IR_GENERIC_CALL,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_INDEX,
  IR_ITERATOR_VALUE,
  IR_LOAD_ARRAY_LENGTH,
  IR_LOAD_ELEMENT,
  IR_NEW_ARRAY,
  IR_NEW_OBJECT,
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
  irStoreText,
  iteratorSourceOf,
  memberCalled,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { boundedIndex, constantAt, type Stamp } from "./guards.js";
import {
  arrayBufferBytes,
  bufferElementOffset,
  callableOf,
  commonShapeOf,
  declaredTypeOf,
  heldTypeOf,
  isLiteralShapeName,
  joinedLiteralShape,
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
import { declaredTypeAt, declaredTypeNameOf } from "../metadata/call-signatures.js";
import {
  builtinOwnerMember,
  declaredNameOf,
  DECLARED_INT,
  nominalLatticeType,
} from "../types/declared.js";
import { isUnwritten } from "../types/signature.js";
import { arrayElementType, arrayOfType } from "../../frontend/checker/type-system.js";
import { latticeFromElementsKind } from "../types/elements.js";
import {
  doubleType,
  joinTypes,
  neverType,
  objectType,
  TypeKind,
  type ArrayType,
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
  SCALAR_FLOAT64,
  SCALAR_STRING,
  SCALAR_TEXT,
  SCALAR_VOID,
  type AotScalar,
} from "../types/scalar.js";

const METHOD_MEMBER = "method";
const GETTER_MEMBER = "getter";
const LENGTH_MEMBER = "length";
const PUSH_MEMBER = "push";
const ONE_ELEMENT = 1;
const EMPTY_LENGTH = 0;
const CALLEE_AND_RECEIVER = 2;
const OUT_OF_RANGE = "array index is out of range";

const READS_ELEMENT: ReadonlySet<string> = new Set<string>([
  IR_LOAD_ELEMENT,
  IR_GENERIC_GET_INDEX,
]);

const WRITES_ELEMENT: ReadonlySet<string> = new Set<string>([
  IR_STORE_ELEMENT,
  IR_GENERIC_SET_INDEX,
]);

const FLATTENS_ONE_LEVEL = "flat";

const HOLDS_ELEMENT_TYPE: ReadonlySet<string> = new Set<string>([
  "concat",
  "slice",
  "filter",
  "reverse",
  "sort",
]);

const SUBSCRIPTS: ReadonlySet<string> = new Set<string>([
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
]);

function pushedValue(use: CFGInstruction, array: CFGInstruction): CFGInstruction | null {
  if (memberCalled(use, PUSH_MEMBER) === null || use.inputs[1] !== array) return null;
  return use.inputs[2] ?? null;
}

function aliasesOf(allocation: CFGInstruction): ReadonlySet<CFGInstruction> {
  const aliases = new Set<CFGInstruction>([allocation]);
  const pending = [allocation];
  while (pending.length > 0) {
    for (const use of pending.pop()!.uses) {
      if (use.type !== IR_PHI || aliases.has(use)) continue;
      aliases.add(use);
      pending.push(use);
    }
  }
  return aliases;
}

function storedValues(allocation: CFGInstruction): CFGInstruction[] {
  const aliases = aliasesOf(allocation);
  const values = [...allocation.inputs];
  for (const array of aliases) {
    for (const use of array.uses) {
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

function readMemberType(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  const owner = value.inputs[0];
  const member = value.props.propName;
  if (owner === undefined || typeof member !== "string") return null;
  const shape = receiverShape(owner, graph, classes, types);
  if (shape === null) return builtinAnswerOf(owner, member, graph, classes, types);
  const held = shape.fields.get(member)?.declaredType ?? null;
  if (held !== null) return held;
  const answered = callableOf(shape.callables, GETTER_MEMBER, member)?.signature.returns;
  return isUnwritten(answered) ? null : answered!;
}

export function producedTypeName(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  const source = iteratedArrayOf(value);
  if (source !== null) return arrayElementNameOf(source, graph, classes, types);
  if (value.type === IR_GENERIC_GET_PROP) {
    const declared = readMemberType(value, graph, classes, types);
    if (declared !== null) return declared;
  }
  return answeredTypeName(value, graph, classes, types);
}

function producedType(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): LatticeType | null {
  const answered = producedTypeName(value, graph, classes, types);
  return answered === null ? null : nominalLatticeType(answered, classes);
}

export function iteratedArrayOf(value: CFGInstruction): CFGInstruction | null {
  if (READS_ELEMENT.has(value.type)) return value.inputs[0] ?? null;
  return value.type === IR_ITERATOR_VALUE ? iteratorSourceOf(value) : null;
}

function receiverShape(
  receiver: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  const type = types.typeOf(receiver);
  if (type.kind === TypeKind.Object && typeof type.map === "number") {
    return classes.shapeById(type.map);
  }
  const array = iteratedArrayOf(receiver);
  if (array === null) return null;
  const element = arrayElementNameOf(array, graph, classes, types);
  return element === null ? null : classes.shapeOf(element);
}

function builtinAnswerOf(
  receiver: CFGInstruction,
  member: string,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  const owner =
    declaredNameOf(types.typeOf(receiver)) ??
    producedTypeName(receiver, graph, classes, types);
  if (owner === null) return null;
  return builtinOwnerMember(owner, member)?.signature.returns ?? null;
}

const TAKES_ELEMENT: ReadonlySet<string> = new Set<string>(["pop", "shift"]);

function answeredTypeName(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  if (value.type !== IR_GENERIC_CALL || value.props.isMethod !== true) return null;
  const callee = value.inputs[0];
  const receiver = value.inputs[1];
  if (callee?.type !== IR_GENERIC_GET_PROP || receiver === undefined) return null;
  const member = callee.props.propName;
  if (typeof member !== "string") return null;
  if (TAKES_ELEMENT.has(member)) {
    const taken = arrayElementNameOf(receiver, graph, classes, types);
    if (taken !== null) return taken;
  }
  const shape = receiverShape(receiver, graph, classes, types);
  const answered =
    shape === null
      ? builtinAnswerOf(receiver, member, graph, classes, types)
      : callableOf(shape.callables, METHOD_MEMBER, member)?.signature.returns;
  return isUnwritten(answered) ? null : answered!;
}

function valueTypeOf(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): LatticeType {
  const shape = classOfValue(value, classes, types);
  if (shape !== null) return objectType(shape.id);
  return producedType(value, graph, classes, types) ?? types.typeOf(value);
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
  const common = commonShapeOf(classes, shapes) ?? joinedLiteralShape(classes, shapes);
  return common === null ? null : objectType(common.id);
}

function adoptElementShape(
  values: readonly CFGInstruction[],
  element: ClassShape | null,
  classes: ClassTable,
): void {
  if (element === null || !isLiteralShapeName(element.name)) return;
  for (const value of values) {
    if (value.type !== IR_NEW_OBJECT) continue;
    const carried = value.props[VALUE_CLASS_PROP];
    if (typeof carried !== "number" || carried === element.id) continue;
    const held = classes.shapeById(carried);
    if (held === null || !isLiteralShapeName(held.name)) continue;
    value.props[CLASS_ID_PROP] = element.id;
    value.props[INSTANCE_SIZE_PROP] = element.size;
    value.props[VALUE_CLASS_PROP] = element.id;
  }
}

function answersUnnamed(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): boolean {
  return (
    value.type === IR_GENERIC_CALL && producedTypeName(value, graph, classes, types) === null
  );
}

export interface KnownElement<Held> {
  readonly held: Held;
  readonly guessed: boolean;
}

export type ArrayElementNaming = KnownElement<string>;

function known<Held>(held: Held): KnownElement<Held> {
  return { held, guessed: false };
}

function inferredElementOf(
  array: ArrayType,
  values: readonly CFGInstruction[],
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): KnownElement<LatticeType> | null {
  const carried = latticeFromElementsKind(array.elementsKind);
  let joined: LatticeType = carried.kind === TypeKind.Any ? neverType() : carried;
  let absent = false;
  for (const value of values) {
    if (answersUnnamed(value, graph, classes, types)) continue;
    const stored = valueTypeOf(value, graph, classes, types);
    absent ||= stored.kind === TypeKind.Nullish;
    if (!absent && isStorableScalar(aotScalarOf(stored)) === null) return null;
    joined = joinTypes(joined, stored)!;
  }
  if (heldTypeOf(joined, classes) !== null) return known(joined);
  if (absent) return null;
  const shared = sharedClass(values, classes, types);
  return shared === null ? { held: doubleType(), guessed: true } : known(shared);
}

function holdsEvery(
  values: readonly CFGInstruction[],
  element: LatticeType,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): boolean {
  const model = arrayModelForElement(classes, element);
  if (model === null) return false;
  return values.every((value) => {
    const stored = aotScalarOf(valueTypeOf(value, graph, classes, types));
    return stored !== null && fits(stored, model.element);
  });
}

function elementTypeOf(
  allocation: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): KnownElement<LatticeType> | null {
  const array = types.typeOf(allocation);
  if (array.kind !== TypeKind.Array) return null;
  const values = storedValues(allocation);
  const inferred = inferredElementOf(array, values, graph, classes, types);
  if (inferred === null) return null;
  const demanded = demandedElementOf(allocation, graph, classes, types);
  if (demanded === null) return inferred;
  if (aotScalarOf(demanded) === aotScalarOf(inferred.held)) return known(inferred.held);
  return holdsEvery(values, demanded, graph, classes, types) ? known(demanded) : inferred;
}

function fits(value: AotScalar, element: AotScalar): boolean {
  if (value === SCALAR_VOID) return element === SCALAR_FLOAT64 || element === SCALAR_POINTER;
  if (element === SCALAR_TEXT) return value === SCALAR_STRING || value === SCALAR_TEXT;
  return isReferenceScalar(element) || isReferenceScalar(value)
    ? value === element
    : isNumericScalar(value);
}

export interface ArrayModel {
  readonly shape: ClassShape;
  readonly buffer: ClassShape;
  readonly element: AotScalar;
  readonly declaredType: string;
  readonly elementShape: ClassShape | null;
}

function modelOf(shape: ClassShape | null, classes: ClassTable): ArrayModel | null {
  if (shape === null) return null;
  const layout = classes.arrayLayoutOf(shape);
  if (layout === null) return null;
  const named = classes.shapeOf(layout.declaredType);
  const elementShape = named ?? nestedArrayShape(layout.declaredType, classes);
  return { shape, ...layout, elementShape };
}

function nestedElementNameOf(declared: string | null): string | null {
  const element = declared === null ? null : arrayElementType(declared);
  if (element === null) return null;
  return arrayElementType(element) === null ? null : element;
}

function nestedArrayShape(declared: string, classes: ClassTable): ClassShape | null {
  const element = arrayElementType(declared);
  if (element === null) return null;
  return classes.defineArray(nominalLatticeType(element, classes), element);
}

function shapedArray(array: CFGInstruction, classes: ClassTable): ArrayModel | null {
  const carried = array.props[VALUE_CLASS_PROP];
  return modelOf(typeof carried === "number" ? classes.shapeById(carried) : null, classes);
}

function enclosingArrayOf(
  use: CFGInstruction,
  value: CFGInstruction,
): CFGInstruction | null {
  if (use.type === IR_NEW_ARRAY) return use.inputs.includes(value) ? use : null;
  if (WRITES_ELEMENT.has(use.type) && use.inputs[2] === value) return use.inputs[0] ?? null;
  if (pushedValue(use, use.inputs[1]!) === value) return use.inputs[1] ?? null;
  return null;
}

function heldElementType(
  use: CFGInstruction,
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  seen: Set<CFGInstruction>,
): string | null {
  const enclosing = enclosingArrayOf(use, value);
  if (enclosing === null) return null;
  const declared = declaredArrayTypeOf(enclosing, graph, classes, types, seen);
  return declared === null ? null : arrayElementType(declared);
}

function declaredArrayTypeOf(
  array: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  seen: Set<CFGInstruction> = new Set<CFGInstruction>(),
): string | null {
  const own = declaredTypeNameOf(array, graph, classes, types);
  if (own !== null) return own;
  if (seen.has(array)) return null;
  seen.add(array);
  const source = iteratedArrayOf(array);
  if (source !== null) {
    const holder = declaredArrayTypeOf(source, graph, classes, types, seen);
    const element = holder === null ? null : arrayElementType(holder);
    if (element !== null) return element;
  }
  for (const alias of aliasesOf(array)) {
    for (const use of alias.uses) {
      for (const [at, input] of use.inputs.entries()) {
        if (input !== alias) continue;
        const declared =
          declaredTypeAt(use, at, graph, classes, types) ??
          heldElementType(use, alias, graph, classes, types, seen);
        if (declared !== null) return declared;
      }
    }
  }
  return null;
}

function demandedElementOf(
  allocation: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): LatticeType | null {
  let demanded: LatticeType | null = null;
  for (const array of aliasesOf(allocation)) {
    for (const use of array.uses) {
      for (const [at, input] of use.inputs.entries()) {
        if (input !== array) continue;
        const declared =
          declaredTypeAt(use, at, graph, classes, types) ??
          heldElementType(use, array, graph, classes, types, new Set<CFGInstruction>());
        const element = declared === null ? null : arrayElementType(declared);
        if (element === null) continue;
        const asked = nominalLatticeType(element, classes);
        if (demanded === null) demanded = asked;
        else if (aotScalarOf(demanded) !== aotScalarOf(asked)) return null;
      }
    }
  }
  return demanded;
}

function receivedElement(
  array: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): LatticeType | null {
  const type = types.typeOf(array);
  if (type.kind === TypeKind.Array) {
    const carried = latticeFromElementsKind(type.elementsKind);
    if (declaredTypeOf(carried, classes) !== null) return carried;
  }
  const declared = declaredArrayTypeOf(array, graph, classes, types);
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
  const named = nestedElementNameOf(declaredArrayTypeOf(array, graph, classes, types));
  return modelOf(classes.defineArray(carried, named ?? undefined), classes);
}

function answeredArray(
  array: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ArrayModel | null {
  if (array.type !== IR_GENERIC_CALL || array.props.isMethod !== true) return null;
  const callee = array.inputs[0];
  if (callee?.type !== IR_GENERIC_GET_PROP) return null;
  const member = callee.props.propName;
  if (typeof member !== "string") return null;
  const held = arrayModelOf(array.inputs[1], graph, classes, types);
  if (held === null) {
    return arrayModelForDeclaredType(
      answeredTypeName(array, graph, classes, types),
      classes,
    );
  }
  if (HOLDS_ELEMENT_TYPE.has(member)) return held;
  return member === FLATTENS_ONE_LEVEL ? modelOf(held.elementShape, classes) : null;
}

const merging = new Set<CFGInstruction>();

function mergedArray(
  array: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ArrayModel | null {
  if (array.type !== IR_PHI || merging.has(array)) return null;
  merging.add(array);
  try {
    let found: ArrayModel | null = null;
    for (const input of array.inputs) {
      if (merging.has(input)) continue;
      const held = arrayModelOf(input, graph, classes, types);
      if (held === null) return null;
      if (found !== null && found.shape.id !== held.shape.id) return null;
      found = held;
    }
    return found;
  } finally {
    merging.delete(array);
  }
}

export function arrayModelOf(
  array: CFGInstruction | undefined,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ArrayModel | null {
  if (array === undefined) return null;
  return (
    shapedArray(array, classes) ??
    receivedArray(array, graph, classes, types) ??
    answeredArray(array, graph, classes, types) ??
    mergedArray(array, graph, classes, types)
  );
}

export function arrayModelForDeclaredType(
  declared: string | null | undefined,
  classes: ClassTable,
): ArrayModel | null {
  if (typeof declared !== "string") return null;
  const element = arrayElementType(declared);
  if (element === null) return null;
  const named = arrayElementType(element) === null ? undefined : element;
  return modelOf(classes.defineArray(nominalLatticeType(element, classes), named), classes);
}

const naming = new Set<CFGInstruction>();

function literalElementNameOf(
  array: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ArrayElementNaming | null {
  const element = elementTypeOf(array, graph, classes, types);
  if (element === null) return null;
  const name =
    element.held.kind === TypeKind.Array
      ? heldArrayNameOf(array, graph, classes, types)
      : heldTypeOf(element.held, classes);
  return name === null ? null : { held: name, guessed: element.guessed };
}

function heldArrayNameOf(
  array: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  let shared: string | null = null;
  for (const value of storedValues(array)) {
    const held = arrayElementNameOf(value, graph, classes, types);
    if (held === null || (shared !== null && shared !== held)) return null;
    shared = held;
  }
  return shared === null ? null : arrayOfType(shared);
}

export function arrayElementNamingOf(
  array: CFGInstruction | undefined,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ArrayElementNaming | null {
  if (array === undefined || naming.has(array)) return null;
  naming.add(array);
  try {
    const model = arrayModelOf(array, graph, classes, types);
    if (model !== null) return known(model.declaredType);
    return array.type === IR_NEW_ARRAY
      ? literalElementNameOf(array, graph, classes, types)
      : null;
  } finally {
    naming.delete(array);
  }
}

export function arrayElementNameOf(
  array: CFGInstruction | undefined,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  return arrayElementNamingOf(array, graph, classes, types)?.held ?? null;
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
  store.props[FIELD_TYPE_PROP] = DECLARED_INT;
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
  load.props[FIELD_TYPE_PROP] = DECLARED_INT;
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

function allocate(
  editor: GraphEditor,
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  stamp: Stamp,
): boolean {
  const carried = elementTypeOf(node, graph, classes, types);
  if (carried === null) return false;
  const named = nestedElementNameOf(declaredArrayTypeOf(node, graph, classes, types));
  const model = modelOf(classes.defineArray(carried.held, named ?? undefined), classes);
  if (model === null) return false;
  adoptElementShape(storedValues(node), model.elementShape, classes);
  for (const value of node.inputs) {
    const stored = aotScalarOf(valueTypeOf(value, graph, classes, types));
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
    const offset = bufferElementOffset(model.element, index);
    const store = stamp(
      model.element === SCALAR_TEXT
        ? irStoreText(buffer, offset, value, scalarWidth(SCALAR_TEXT), String(index))
        : irStoreField(buffer, offset, value, String(index)),
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
  if (model.elementShape !== null) access.props[VALUE_CLASS_PROP] = model.elementShape.id;
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
  graph: CFGFunction,
  editor: GraphEditor,
  node: CFGInstruction,
  model: ArrayModel,
  stamp: Stamp,
): void {
  const index = SUBSCRIPTS.has(node.type)
    ? boundedIndex(
        graph,
        editor,
        node,
        node.inputs[1]!,
        loadCount(editor, node, node.inputs[0]!, ARRAY_LENGTH_OFFSET, model, stamp),
        OUT_OF_RANGE,
        stamp,
      )
    : node.inputs[1]!;
  const buffer = loadBuffer(editor, node, node.inputs[0]!, model, stamp);
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

export function arrayModelForShape(
  classes: ClassTable,
  shape: ClassShape | null,
): ArrayModel | null {
  return modelOf(shape, classes);
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
  editor.removeIfDead(callee);
}

function readsLength(node: CFGInstruction): boolean {
  if (node.type === IR_LOAD_ARRAY_LENGTH) return true;
  return node.type === IR_GENERIC_GET_PROP && String(node.props.propName) === LENGTH_MEMBER;
}

function allocationOrder(graph: CFGFunction): CFGInstruction[] {
  const pending = new Set<CFGInstruction>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_NEW_ARRAY && node.block === block) pending.add(node);
    }
  }
  const ordered: CFGInstruction[] = [];
  const opened = new Set<CFGInstruction>();
  const placed = new Set<CFGInstruction>();
  for (const start of pending) {
    if (opened.has(start)) continue;
    const stack: CFGInstruction[] = [start];
    while (stack.length > 0) {
      const node = stack[stack.length - 1]!;
      if (!opened.has(node)) {
        opened.add(node);
        for (const value of storedValues(node)) {
          if (pending.has(value) && !opened.has(value)) stack.push(value);
        }
        continue;
      }
      stack.pop();
      if (placed.has(node)) continue;
      placed.add(node);
      ordered.push(node);
    }
  }
  return ordered;
}

export function shapeArrayAllocations(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let changed = 0;

  for (const node of allocationOrder(graph)) {
    if (allocate(editor, node, graph, classes, types, stamp)) changed++;
  }
  if (changed > 0) graph.rebuildUses();
  return changed;
}

export function stampElementTypes(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  let stamped = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!READS_ELEMENT.has(node.type)) continue;
      const named = node.props[FIELD_TYPE_PROP];
      const element =
        typeof named === "string"
          ? named
          : arrayElementNameOf(node.inputs[0], graph, classes, types);
      if (element === null) continue;
      if (named === undefined) {
        node.props[FIELD_TYPE_PROP] = element;
        stamped++;
      }
      if (node.props[VALUE_CLASS_PROP] !== undefined) continue;
      const shape = classes.shapeOf(element);
      if (shape === null || classes.arrayLayoutOf(shape) === null) continue;
      node.props[VALUE_CLASS_PROP] = shape.id;
      stamped++;
    }
  }
  return stamped;
}

export function lowerArrayAccess(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let changed = 0;

  for (let index = 0; index < graph.blocks.length; index++) {
    const block = graph.blocks[index]!;
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
      else replaceElement(graph, editor, node, model, stamp);
    }
  }
  if (changed > 0) graph.rebuildUses();
  return changed;
}
