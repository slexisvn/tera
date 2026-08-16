import { TERA_STATICS } from "../target/runtime-layout.js";
import {
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_PROP,
  IR_LOAD_ELEMENT,
  IR_NEW_OBJECT,
  irBranch,
  irCallKnownFunction,
  irConstant,
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
import { scalarWidth, SCALAR_INT32, SCALAR_TEXT } from "../types/scalar.js";
import type { TypeInference } from "../analyses/type-inference.js";
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

function constructedShapeOf(node: CFGInstruction, classes: ClassTable): ClassShape | null {
  if (node.type !== IR_GENERIC_CALL) return null;
  const name = genericCalleeName(node);
  return name === null ? null : classes.shapeOf(name);
}

function allocatesReceiver(receiver: CFGInstruction): boolean {
  return receiver.type === IR_NEW_OBJECT || receiver.type === IR_GENERIC_CALL;
}

function shapeOfReceiver(
  receiver: CFGInstruction | undefined,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  if (receiver === undefined) return null;
  const carried = receiver.props[VALUE_CLASS_PROP];
  if (typeof carried === "number") return classes.shapeById(carried);
  const type = types.typeOf(receiver);
  if (type.kind === TypeKind.Object && typeof type.map === "number") {
    return classes.shapeById(type.map);
  }
  return (
    constructedShapeOf(receiver, classes) ?? elementShapeOf(receiver, graph, classes, types)
  );
}

function shapeOfClassValue(
  node: CFGInstruction | undefined,
  classes: ClassTable,
): ClassShape | null {
  const name = classValueNameOf(node);
  return name === null ? null : classes.shapeOf(name);
}

function carryValueClass(node: CFGInstruction, declaredType: string, classes: ClassTable): void {
  const shapeId = classes.shapeIdOf(declaredType);
  if (shapeId !== null) node.props[VALUE_CLASS_PROP] = shapeId;
}

function calleeResultClass(
  graph: CFGFunction,
  node: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): string | null {
  if (node.type === IR_CALL_KNOWN_FUNCTION) {
    const target = node.props.target as
      | { declaredSignature?: { returns?: string | null } | null }
      | undefined;
    return target?.declaredSignature?.returns ?? null;
  }
  const call = memberCallFor(graph, node, classes, types);
  if (call === null || call.targets.length > 1) return null;
  return call.targets[0]!.signature.returns;
}

function carryCalleeResultClasses(
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
): void {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const returns = calleeResultClass(graph, node, classes, types);
      if (returns !== null) carryValueClass(node, returns, classes);
    }
  }
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
): MemberCall | null {
  if (node.type !== IR_GENERIC_CALL) return null;
  const callee = node.inputs[0];
  if (callee === undefined) return null;
  if (callee.type !== IR_GENERIC_GET_PROP) return superConstructorCall(graph, node, classes);

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

function constructedShape(node: CFGInstruction, classes: ClassTable): ClassShape | null {
  if (node.type !== IR_CALL_KNOWN_FUNCTION) return null;
  if (node.props[INITIALIZES_PROP] === true) return null;
  const target = node.props.target as { name?: unknown } | undefined;
  if (typeof target?.name !== "string") return null;
  const shape = classes.shapeOf(target.name);
  return shape !== null && shape.constructorSymbol === target.name ? shape : null;
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

  const initialize = stamp(
    irCallKnownFunction(node.props.target as never, [allocation, ...node.inputs]),
  );
  initialize.props[INITIALIZES_PROP] = true;
  carryNamedArguments(node, initialize);
  initialize.frameState = node.frameState;
  editor.insertBefore(node, initialize);
  editor.replaceAllUses(node, allocation);
  editor.remove(node);
}

function shapeIdOfReceiver(
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

  if (merged !== null) replaceValueUses(graph, node, merged);
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

export function resolveCalleeSignatures(graph: CFGFunction, types: TypeInference): number {
  if (graph.calleeSignatures === null) return 0;
  const resolved = stampCalleeSignatures(graph, graph.calleeSignatures);
  if (graph.classes !== null) carryCalleeResultClasses(graph, graph.classes, types);
  return resolved;
}

export function lowerClassMembers(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;

  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const shape = constructedShape(node, classes);
      if (shape !== null) {
        applyConstruction(editor, node, shape, stamp);
        count++;
        continue;
      }
      const call = memberCallFor(graph, node, classes, types);
      if (call !== null) {
        applyMemberCall(editor, graph, call, classes, stamp);
        count++;
        continue;
      }
      const access = fieldAccessFor(node, graph, classes, types);
      if (access !== null) {
        applyFieldAccess(editor, access, classes, stamp);
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
