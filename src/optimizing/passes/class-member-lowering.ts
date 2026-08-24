import { TERA_STATICS } from "../target/runtime-layout.js";
import {
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  IR_CONSTANT,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_IN,
  IR_GENERIC_SET_INDEX,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_PROP,
  IR_LOAD_ELEMENT,
  IR_LOAD_FIELD,
  IR_NEW_OBJECT,
  IR_PHI,
  type IRMetadataValue,
  irBranch,
  irCallKnownFunction,
  irConstant,
  irGenericGetProp,
  irGenericSetProp,
  irInt32Compare,
  irJump,
  irLoadField,
  irLoadText,
  irNewObject,
  irRuntimeBase,
  irStoreField,
  irStoreText,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockAfter } from "../ir/cfg-edit.js";
import {
  carryNamedArguments,
  genericCalleeName,
  stampCalleeSignatures,
} from "../metadata/call-signatures.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper, replaceValueUses } from "../ir/graph-edit.js";
import type { ClassCallableKind } from "../../core/class-member.js";
import { classValueNameOf } from "../metadata/class-symbols.js";
import { splitCellKey } from "../../runtime/intrinsics/global-cells.js";
import {
  callableOf,
  CLASS_ID_PROP,
  CLASS_SHAPE_ID_OFFSET,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  INSTANCE_SIZE_PROP,
  VALUE_CLASS_PROP,
  type ClassField,
  type ClassMethod,
  type ClassStaticField,
  type ClassShape,
  type ClassTable,
} from "../metadata/class-table.js";
import { arrayElementShapeOf } from "./array-shapes.js";
import { TypeKind } from "../types/lattice.js";
import { nominalLatticeType, presentTypeName } from "../types/declared.js";
import { scalarWidth, SCALAR_INT32, SCALAR_TEXT } from "../types/scalar.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { isPairClassName, PAIR_FIELDS } from "../prelude/collections.js";
import type { DeclaredSignature } from "../types/signature.js";

const SHAPE_ID_TYPE = "int";
const CALLEE_AND_RECEIVER = 2;

const INITIALIZES_PROP = "initializesReceiver";

type Stamp = (node: CFGInstruction) => CFGInstruction;

type FieldAccess = {
  readonly node: CFGInstruction;
  readonly receiver: CFGInstruction | null;
  readonly field: ClassField | ClassStaticField;
};

type MemberCall = {
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction | null;
  readonly args: CFGInstruction[];
  readonly targets: readonly ClassMethod[];
  readonly dispatchOn: ClassShape | null;
  readonly kind: ClassCallableKind;
};

type DispatchArm = {
  readonly classId: number;
  readonly target: ClassMethod;
};

export function constructedShapeOf(node: CFGInstruction, classes: ClassTable): ClassShape | null {
  if (node.type !== IR_GENERIC_CALL) return null;
  const name = genericCalleeName(node);
  return name === null ? null : classes.shapeOf(name);
}

function allocatesReceiver(receiver: CFGInstruction): boolean {
  return receiver.type === IR_NEW_OBJECT || receiver.type === IR_GENERIC_CALL;
}

function shapeOfValue(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  const carried = value.props[VALUE_CLASS_PROP];
  if (typeof carried === "number") return classes.shapeById(carried);
  const type = types.typeOf(value);
  if (type.kind === TypeKind.Object && typeof type.map === "number") {
    return classes.shapeById(type.map);
  }
  return constructedShapeOf(value, classes) ?? elementShapeOf(value, graph, classes, types);
}

function readsFrom(value: CFGInstruction, receiver: CFGInstruction): boolean {
  return (
    (value.type === IR_GENERIC_GET_PROP || value.type === IR_LOAD_FIELD) &&
    value.inputs[0] === receiver
  );
}

function loopReceiverShape(
  phi: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  if (phi.type !== IR_PHI) return null;
  let agreed: ClassShape | null = null;
  for (const input of phi.inputs) {
    if (readsFrom(input, phi)) continue;
    const shape = shapeOfValue(input, graph, classes, types);
    if (shape === null || (agreed !== null && agreed !== shape)) return null;
    agreed = shape;
  }
  return agreed;
}

function shapeOfReceiver(
  receiver: CFGInstruction | undefined,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  if (receiver === undefined) return null;
  return (
    shapeOfValue(receiver, graph, classes, types) ??
    loopReceiverShape(receiver, graph, classes, types)
  );
}

function shapeOfClassValue(
  node: CFGInstruction | undefined,
  classes: ClassTable,
): ClassShape | null {
  const name = classValueNameOf(node);
  return name === null ? null : classes.shapeOf(name);
}

function declaredShapeId(declaredType: string, classes: ClassTable): number | null {
  const named = classes.shapeIdOf(declaredType) ?? classes.shapeIdOf(presentTypeName(declaredType));
  if (named !== null) return named;
  const type = nominalLatticeType(declaredType, classes);
  return type.kind === TypeKind.Object && typeof type.map === "number" ? type.map : null;
}

export function carryValueClass(
  node: CFGInstruction,
  declaredType: string,
  classes: ClassTable,
): boolean {
  const shapeId = declaredShapeId(declaredType, classes);
  if (shapeId === null || node.props[VALUE_CLASS_PROP] === shapeId) return false;
  node.props[VALUE_CLASS_PROP] = shapeId;
  return true;
}

function stampedSignatureOf(node: CFGInstruction): DeclaredSignature | null {
  const target = node.props.target as { declaredSignature?: DeclaredSignature } | undefined;
  return target?.declaredSignature ?? null;
}

function agreedMemberSignature(
  graph: CFGFunction,
  node: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): DeclaredSignature | null {
  const call = memberCallFor(graph, node, classes, types);
  const first = call?.targets[0];
  if (call === null || first === undefined) return null;
  const answered = targetSignatureOf(graph, first);
  return call.targets.every(
    (target) => targetSignatureOf(graph, target).returns === answered.returns,
  )
    ? answered
    : null;
}

function calleeSignatureOf(
  graph: CFGFunction,
  node: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): DeclaredSignature | null {
  if (node.type === IR_CALL_KNOWN_FUNCTION) return stampedSignatureOf(node);
  return agreedMemberSignature(graph, node, classes, types);
}

function adoptAnsweredSignature(node: CFGInstruction, answered: DeclaredSignature): boolean {
  if (node.type !== IR_GENERIC_CALL || stampedSignatureOf(node) === answered) return false;
  const target = node.props.target as Record<string, unknown> | undefined;
  node.props.target = { ...target, declaredSignature: answered } as unknown as IRMetadataValue;
  return true;
}

function adoptAnsweredSignatures(
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): number {
  let stamped = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const answered = agreedMemberSignature(graph, node, classes, types);
      if (answered !== null && adoptAnsweredSignature(node, answered)) stamped += 1;
    }
  }
  return stamped;
}

function carryCalleeResultClasses(
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): number {
  let carried = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const returns = calleeSignatureOf(graph, node, classes, types)?.returns ?? null;
      if (returns !== null && carryValueClass(node, returns, classes)) carried += 1;
    }
  }
  return carried;
}

function elementShapeOf(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  if (node.type !== IR_LOAD_ELEMENT && node.type !== IR_GENERIC_GET_INDEX) return null;
  const element = arrayElementShapeOf(node.inputs[0], graph, classes, types);
  if (element !== null) node.props[VALUE_CLASS_PROP] = element.id;
  return element;
}

function fieldAccessFor(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): FieldAccess | null {
  if (node.type !== IR_GENERIC_GET_PROP && node.type !== IR_GENERIC_SET_PROP) return null;
  const receiver = node.inputs[0];
  const name = String(node.props.propName);

  const named = shapeOfClassValue(receiver, classes);
  if (named !== null) {
    const stat = named.staticFields.get(name);
    return stat === undefined ? null : { node, receiver: null, field: stat };
  }
  const shape = shapeOfReceiver(receiver, graph, classes, types);
  if (shape === null) return null;
  const field = shape.fields.get(name);
  if (field === undefined) return null;
  return { node, receiver: receiver!, field };
}

function fieldAccessNode(
  node: CFGInstruction,
  receiver: CFGInstruction,
  field: ClassField | ClassStaticField,
): CFGInstruction {
  const loads = node.type === IR_GENERIC_GET_PROP;
  if (field.scalar === SCALAR_TEXT) {
    const capacity = scalarWidth(SCALAR_TEXT);
    return loads
      ? irLoadText(receiver, field.offset, capacity, field.name)
      : irStoreText(receiver, field.offset, node.inputs[1]!, capacity, field.name);
  }
  return loads
    ? irLoadField(receiver, field.offset)
    : irStoreField(receiver, field.offset, node.inputs[1]!, field.name);
}

export function fieldLoadNode(
  receiver: CFGInstruction,
  field: ClassField,
  classes: ClassTable,
): CFGInstruction {
  const load =
    field.scalar === SCALAR_TEXT
      ? irLoadText(receiver, field.offset, scalarWidth(SCALAR_TEXT), field.name)
      : irLoadField(receiver, field.offset);
  load.props[CLASS_ID_PROP] = classes.shapeIdOf(field.owner);
  load.props[FIELD_TYPE_PROP] = field.declaredType;
  load.props[FIELD_SCALAR_PROP] = field.scalar;
  carryValueClass(load, field.declaredType, classes);
  return load;
}

function applyFieldAccess(
  editor: GraphEditor,
  access: FieldAccess,
  classes: ClassTable,
  stamp: Stamp,
): void {
  const { node, field } = access;
  let receiver = access.receiver;
  if (receiver === null) {
    receiver = stamp(irRuntimeBase(TERA_STATICS.symbol));
    editor.insertBefore(node, receiver);
  }
  const replacement = stamp(fieldAccessNode(node, receiver, field));
  replacement.props[CLASS_ID_PROP] = classes.shapeIdOf(field.owner);
  replacement.props[FIELD_TYPE_PROP] = field.declaredType;
  replacement.props[FIELD_SCALAR_PROP] = field.scalar;
  if (node.type === IR_GENERIC_GET_PROP) carryValueClass(replacement, field.declaredType, classes);
  replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
}

function constructorTargetOf(shape: ClassShape): ClassMethod {
  return {
    name: shape.name,
    owner: shape.name,
    symbol: shape.constructorSymbol,
    signature: shape.constructorSignature,
    abstract: false,
  };
}

function superConstructorCall(
  graph: CFGFunction,
  node: CFGInstruction,
  classes: ClassTable,
): MemberCall | null {
  if (node.props.isMethod !== true || !graph.receiver || graph.classOwner === null) return null;
  if (node.inputs[1] !== graph.parameters[0]) return null;
  const parent = classes.shapeOf(graph.classOwner)?.parent ?? null;
  if (parent === null || classValueNameOf(node.inputs[0]) !== parent) return null;
  const parentShape = classes.shapeOf(parent);
  if (parentShape === null) return null;
  return {
    node,
    callee: null,
    args: node.inputs.slice(1),
    targets: [constructorTargetOf(parentShape)],
    dispatchOn: null,
    kind: "method",
  };
}

function staticCall(
  node: CFGInstruction,
  callee: CFGInstruction | null,
  shape: ClassShape,
  name: string,
  kind: ClassCallableKind,
  args: CFGInstruction[],
): MemberCall | null {
  const target = callableOf(shape.staticCallables, kind, name);
  if (target === null || target.abstract) return null;
  return { node, callee, args, targets: [target], dispatchOn: null, kind };
}

function exactCall(
  node: CFGInstruction,
  callee: CFGInstruction | null,
  shape: ClassShape,
  name: string,
  kind: ClassCallableKind,
  args: CFGInstruction[],
): MemberCall | null {
  const target = callableOf(shape.callables, kind, name);
  if (target === null || target.abstract) return null;
  return { node, callee, args, targets: [target], dispatchOn: null, kind };
}

function virtualCall(
  node: CFGInstruction,
  callee: CFGInstruction | null,
  shape: ClassShape,
  name: string,
  kind: ClassCallableKind,
  args: CFGInstruction[],
  classes: ClassTable,
): MemberCall | null {
  if (callableOf(shape.callables, kind, name) === null) return null;
  const targets = classes.implementationsOf(shape.name, name, kind);
  if (targets.length === 0) return null;
  return { node, callee, args, targets, dispatchOn: shape, kind };
}

function memberCallFor(
  graph: CFGFunction,
  node: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
  binds = true,
): MemberCall | null {
  if (node.type !== IR_GENERIC_CALL) return null;
  const callee = node.inputs[0];
  if (callee === undefined) return null;
  if (callee.type !== IR_GENERIC_GET_PROP) {
    return binds ? superConstructorCall(graph, node, classes) : null;
  }

  const name = String(callee.props.propName);
  const named = shapeOfClassValue(callee.inputs[0], classes);
  if (named !== null) {
    return node.inputs[1] === callee.inputs[0]
      ? staticCall(node, callee, named, name, "method", node.inputs.slice(2))
      : exactCall(node, callee, named, name, "method", node.inputs.slice(1));
  }
  const receiver = callee.inputs[0]!;
  const shape = shapeOfReceiver(receiver, graph, classes, types);
  if (shape === null || shape.fields.has(name)) return null;
  const args = node.inputs.slice(1);
  if (allocatesReceiver(receiver)) return exactCall(node, callee, shape, name, "method", args);
  return virtualCall(node, callee, shape, name, "method", args, classes);
}

function accessorCallFor(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): MemberCall | null {
  const reading = node.type === IR_GENERIC_GET_PROP;
  if (!reading && node.type !== IR_GENERIC_SET_PROP) return null;
  const receiver = node.inputs[0];
  if (receiver === undefined) return null;
  const name = String(node.props.propName);
  const kind: ClassCallableKind = reading ? "getter" : "setter";
  const written = reading ? [] : [node.inputs[1]!];

  const named = shapeOfClassValue(receiver, classes);
  if (named !== null) return staticCall(node, null, named, name, kind, written);
  const shape = shapeOfReceiver(receiver, graph, classes, types);
  if (shape === null) return null;
  const args = [receiver, ...written];
  if (allocatesReceiver(receiver)) return exactCall(node, null, shape, name, kind, args);
  return virtualCall(node, null, shape, name, kind, args, classes);
}

function targetSignatureOf(graph: CFGFunction, target: ClassMethod): DeclaredSignature {
  return graph.calleeSignatures?.get(target.symbol) ?? target.signature;
}

function applyDirectCall(
  editor: GraphEditor,
  graph: CFGFunction,
  call: MemberCall,
  classes: ClassTable,
  stamp: Stamp,
): void {
  const { node, callee, args } = call;
  const target = call.targets[0]!;
  const replacement = stamp(
    irCallKnownFunction(
      { name: target.symbol, declaredSignature: targetSignatureOf(graph, target) } as never,
      args,
    ),
  );
  if (target.signature.returns !== null) {
    carryValueClass(replacement, target.signature.returns, classes);
  }
  carryNamedArguments(node, replacement);
  replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
  if (callee !== null && callee.uses.length === 0) editor.remove(callee);
}

function polymorphicShapeOf(call: MemberCall): ClassShape | null {
  return call.targets.length > 1 ? call.dispatchOn : null;
}

export function constructedShape(node: CFGInstruction, classes: ClassTable): ClassShape | null {
  if (node.type !== IR_CALL_KNOWN_FUNCTION) return null;
  if (node.props[INITIALIZES_PROP] === true) return null;
  const target = node.props.target as { name?: unknown } | undefined;
  if (typeof target?.name !== "string") return null;
  const shape = classes.shapeOf(target.name);
  if (shape === null) return null;
  return shape.constructorSymbol === splitCellKey(target.name).name ? shape : null;
}

function applyConstruction(
  editor: GraphEditor,
  node: CFGInstruction,
  shape: ClassShape,
  stamp: Stamp,
): void {
  const allocation = stamp(irNewObject());
  allocation.props[CLASS_ID_PROP] = shape.id;
  allocation.props[INSTANCE_SIZE_PROP] = shape.size;
  allocation.props[VALUE_CLASS_PROP] = shape.id;
  allocation.frameState = node.frameState;
  editor.insertBefore(node, allocation);

  const target = node.props.target as { name: string };
  const initialize = stamp(
    irCallKnownFunction(
      { ...target, name: shape.constructorSymbol } as never,
      [allocation, ...node.inputs],
    ),
  );
  initialize.props[INITIALIZES_PROP] = true;
  carryNamedArguments(node, initialize);
  initialize.frameState = node.frameState;
  editor.insertBefore(node, initialize);
  editor.replaceAllUses(node, allocation);
  editor.remove(node);
}

export function shapeIdOfReceiver(
  receiver: CFGInstruction,
  shape: ClassShape,
  stamp: Stamp,
): CFGInstruction {
  const load = stamp(irLoadField(receiver, CLASS_SHAPE_ID_OFFSET));
  load.props[CLASS_ID_PROP] = shape.id;
  load.props[FIELD_TYPE_PROP] = SHAPE_ID_TYPE;
  load.props[FIELD_SCALAR_PROP] = SCALAR_INT32;
  return load;
}

function dispatchArmsFor(
  shape: ClassShape,
  name: string,
  kind: ClassCallableKind,
  classes: ClassTable,
): DispatchArm[] {
  const arms: DispatchArm[] = [];
  for (const candidate of classes.dispatchConeOf(shape.name)) {
    if (candidate.abstract) continue;
    const target = callableOf(candidate.callables, kind, name);
    if (target === null || target.abstract) continue;
    arms.push({ classId: candidate.id, target });
  }
  return arms;
}

function applyDispatchLadder(
  editor: GraphEditor,
  graph: CFGFunction,
  call: MemberCall,
  shape: ClassShape,
  classes: ClassTable,
  stamp: Stamp,
): void {
  const { node, callee, args } = call;
  const arms = dispatchArmsFor(shape, call.targets[0]!.name, call.kind, classes);
  const receiver = args[0]!;
  const block = node.block!;
  const after = splitBlockAfter(graph, block, node);
  const merged = node.uses.length > 0 ? stamp(addPhi(after, [])) : null;

  if (merged !== null) {
    const answered = node.props[VALUE_CLASS_PROP];
    if (answered !== undefined) merged.props[VALUE_CLASS_PROP] = answered;
    replaceValueUses(graph, node, merged);
  }
  editor.remove(node);
  if (callee !== null && callee.uses.length === 0) editor.remove(callee);

  const shapeId = shapeIdOfReceiver(receiver, shape, stamp);
  block.addNode(shapeId);

  let current = block;
  for (let index = 0; index < arms.length; index++) {
    const arm = arms[index]!;
    const invoke = graph.addBlock();
    const result = stamp(
      irCallKnownFunction(
        { name: arm.target.symbol, declaredSignature: targetSignatureOf(graph, arm.target) } as never,
        args,
      ),
    );
    carryNamedArguments(call.node, result);
    invoke.addNode(result);
    invoke.addNode(stamp(irJump(after)));

    if (index === arms.length - 1) {
      current.addNode(stamp(irJump(invoke)));
      link(current, invoke);
    } else {
      const expected = stamp(irConstant(arm.classId));
      current.addNode(expected);
      const test = stamp(irInt32Compare("==", shapeId, expected));
      current.addNode(test);
      const next = graph.addBlock();
      current.addNode(stamp(irBranch(test, invoke, next)));
      link(current, invoke);
      link(current, next);
      current = next;
    }
    connect(invoke, after, merged === null ? [] : [result]);
  }
}

function applyMemberCall(
  editor: GraphEditor,
  graph: CFGFunction,
  call: MemberCall,
  classes: ClassTable,
  stamp: Stamp,
): void {
  const shape = polymorphicShapeOf(call);
  if (shape === null) applyDirectCall(editor, graph, call, classes, stamp);
  else applyDispatchLadder(editor, graph, call, shape, classes, stamp);
}

export interface MemberCallTargets {
  readonly symbols: readonly string[];
  readonly arity: number;
}

export function memberCallTargets(
  graph: CFGFunction,
  node: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): MemberCallTargets | null {
  const call = memberCallFor(graph, node, classes, types);
  if (call === null) return null;
  return {
    symbols: call.targets.map((target) => target.symbol),
    arity: node.inputs.length - CALLEE_AND_RECEIVER,
  };
}

export function answerCallSignatures(graph: CFGFunction, types: TypeInference): number {
  if (graph.calleeSignatures === null) return 0;
  const named = stampCalleeSignatures(graph, graph.calleeSignatures);
  if (graph.classes === null) return named;
  return named + adoptAnsweredSignatures(graph, graph.classes, types);
}

export function resolveCalleeSignatures(graph: CFGFunction, types: TypeInference): number {
  const answered = answerCallSignatures(graph, types);
  if (graph.calleeSignatures === null || graph.classes === null) return answered;
  return answered + carryCalleeResultClasses(graph, graph.classes, types);
}

const KEYED_ACCESS: ReadonlyMap<string, boolean> = new Map<string, boolean>([
  [IR_GENERIC_GET_INDEX, true],
  [IR_GENERIC_SET_INDEX, false],
]);

function memberKeyOf(node: CFGInstruction, shape: ClassShape): string | null {
  const key = node.inputs[1];
  if (key === undefined || key.type !== IR_CONSTANT) return null;
  const value = key.props.value;
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !isPairClassName(shape.name)) return null;
  return PAIR_FIELDS[value] ?? null;
}

function carriesMember(shape: ClassShape, name: string): boolean {
  if (shape.fields.has(name)) return true;
  for (const kind of shape.callables.keys()) {
    if (shape.callables.get(kind)?.has(name) === true) return true;
  }
  return false;
}

function namedAccessFor(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  stamp: Stamp,
): CFGInstruction | null {
  const reading = KEYED_ACCESS.get(node.type);
  if (reading === undefined) return null;
  const shape = shapeOfReceiver(node.inputs[0], graph, classes, types);
  if (shape === null) return null;
  const name = memberKeyOf(node, shape);
  if (name === null || !shape.fields.has(name)) return null;
  const receiver = node.inputs[0]!;
  return stamp(
    reading ? irGenericGetProp(receiver, name) : irGenericSetProp(receiver, name, node.inputs[2]!),
  );
}

function membershipFor(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  stamp: Stamp,
): CFGInstruction | null {
  if (node.type !== IR_GENERIC_IN) return null;
  const key = node.inputs[0];
  if (key === undefined || key.type !== IR_CONSTANT) return null;
  const name = key.props.value;
  if (typeof name !== "string") return null;
  const shape = shapeOfReceiver(node.inputs[1], graph, classes, types);
  if (shape === null) return null;
  const carried = carriesMember(shape, name);
  if (!carried && shape.unsupported.length > 0) return null;
  return stamp(irConstant(carried));
}

function replaceWithNode(
  editor: GraphEditor,
  node: CFGInstruction,
  replacement: CFGInstruction,
): void {
  replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
}

type MemberRound = "all" | "reads";

function lowerMemberRound(
  graph: CFGFunction,
  types: TypeInference,
  classes: ClassTable,
  round: MemberRound = "all",
): number {

  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = carryCalleeResultClasses(graph, classes, types);
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const named = namedAccessFor(node, graph, classes, types, stamp);
      if (named !== null) {
        replaceWithNode(editor, node, named);
        count++;
        const renamed = fieldAccessFor(named, graph, classes, types);
        if (renamed !== null) {
          applyFieldAccess(editor, renamed, classes, stamp);
          count++;
        }
        continue;
      }
      if (round === "all") {
        const whole = lowerWholeMember(editor, graph, node, classes, types, stamp);
        if (whole > 0) {
          count += whole;
          continue;
        }
      }
      const access = fieldAccessFor(node, graph, classes, types);
      if (access !== null) {
        applyFieldAccess(editor, access, classes, stamp);
        count++;
        continue;
      }
      const called = memberCallFor(graph, node, classes, types, false);
      if (called !== null) {
        applyMemberCall(editor, graph, called, classes, stamp);
        count++;
        continue;
      }
      const accessor = accessorCallFor(node, graph, classes, types);
      if (accessor === null) continue;
      applyMemberCall(editor, graph, accessor, classes, stamp);
      count++;
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}

function lowerWholeMember(
  editor: GraphEditor,
  graph: CFGFunction,
  node: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
  stamp: Stamp,
): number {
  const membership = membershipFor(node, graph, classes, types, stamp);
  if (membership !== null) {
    replaceWithNode(editor, node, membership);
    return 1;
  }
  const shape = constructedShape(node, classes);
  if (shape !== null) {
    applyConstruction(editor, node, shape, stamp);
    return 1;
  }
  const call = memberCallFor(graph, node, classes, types);
  if (call === null) return 0;
  applyMemberCall(editor, graph, call, classes, stamp);
  return 1;
}

export function lowerClassMembers(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  return lowerMemberRound(graph, types, classes);
}

export function lowerElementMembers(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  return lowerMemberRound(graph, types, classes, "reads");
}
