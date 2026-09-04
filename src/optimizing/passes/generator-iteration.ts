import {
  irCallKnownFunction,
  irInt32Compare,
  irConstant,
  irLoadField,
  irLoadText,
  irStoreField,
  propertyNameOf,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_ITERATOR_DONE,
  IR_ITERATOR_INIT,
  IR_ITERATOR_NEXT,
  IR_ITERATOR_VALUE,
  IR_LOAD_FIELD,
  IR_LOAD_TEXT,
  IR_PHI,
  IR_STORE_FIELD,
  IR_STORE_TEXT,
  type CFGFunction,
  type CFGInstruction,
  calleeNameOf,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";

import {
  CLASS_ID_PROP,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  VALUE_CLASS_PROP,
  type ClassField,
  type ClassShape,
  type ClassTable,
  type GeneratorShape,
} from "../metadata/class-table.js";
import {
  GEN_FINISHED,
  GEN_STATUS_FIELD,
  GEN_VALUE_FIELD,
} from "../metadata/generators.js";
import { scalarWidth, SCALAR_TEXT } from "../types/scalar.js";
import { BackendLoweringError } from "../target/errors.js";

const MEMBERS: ReadonlySet<string> = new Set<string>(["next", "value", "done"]);
const READS_FRAME: ReadonlySet<string> = new Set<string>([
  IR_LOAD_FIELD,
  IR_LOAD_TEXT,
  IR_STORE_FIELD,
  IR_STORE_TEXT,
]);
const NEXT_MEMBER = "next";
const VALUE_MEMBER = "value";
const DONE_MEMBER = "done";
const RECEIVER = 1;
const NO_ARGUMENTS = 2;

type Stamp = (node: CFGInstruction) => CFGInstruction;

const PROTOCOL: ReadonlySet<string> = new Set<string>([
  IR_ITERATOR_INIT,
  IR_ITERATOR_NEXT,
  IR_ITERATOR_VALUE,
  IR_ITERATOR_DONE,
]);

function fieldOf(shape: ClassShape, name: string): ClassField {
  const field = shape.fields.get(name);
  if (field === undefined) throw new Error(`generator frame has no ${name}`);
  return field;
}

function loadOf(frame: ClassShape, name: string, held: CFGInstruction): CFGInstruction {
  const field = fieldOf(frame, name);
  const load =
    field.scalar === SCALAR_TEXT
      ? irLoadText(held, field.offset, scalarWidth(SCALAR_TEXT), name)
      : irLoadField(held, field.offset);
  load.props[CLASS_ID_PROP] = frame.id;
  load.props[FIELD_SCALAR_PROP] = field.scalar;
  load.props[FIELD_TYPE_PROP] = field.declaredType;
  return load;
}

function declaredNameOf(node: CFGInstruction): string | null {
  const declared = node.props[FIELD_TYPE_PROP];
  return typeof declared === "string" ? declared : null;
}

function producedBy(value: CFGInstruction, classes: ClassTable): GeneratorShape | null {
  const seen = new Set<CFGInstruction>();
  const pending: CFGInstruction[] = [value];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    const named = calleeNameOf(node) ?? declaredNameOf(node);
    const found = named === null ? null : classes.generatorOf(named);
    if (found !== null) return found;
    if (node.type === IR_PHI || PROTOCOL.has(node.type)) {
      for (const input of node.inputs) pending.push(input);
      continue;
    }
    const stepping = calledMember(node);
    if (stepping !== null) pending.push(node.inputs[RECEIVER]!);
  }
  return null;
}

function heldFrame(node: CFGInstruction): CFGInstruction {
  return node.inputs[0]!;
}

function stepped(
  editor: GraphEditor,
  node: CFGInstruction,
  generator: GeneratorShape,
  stamp: Stamp,
): void {
  const held = heldFrame(node);
  const call = stamp(irCallKnownFunction({ name: generator.resume } as never, [held]));
  call.frameState = node.frameState;
  editor.insertBefore(node, call);
  const status = fieldOf(generator.frame, GEN_STATUS_FIELD);
  const store = stamp(irStoreField(held, status.offset, call, GEN_STATUS_FIELD));
  store.props[CLASS_ID_PROP] = generator.frame.id;
  store.props[FIELD_SCALAR_PROP] = status.scalar;
  store.props[FIELD_TYPE_PROP] = status.declaredType;
  editor.insertBefore(node, store);
  editor.replaceAllUses(node, held);
  editor.remove(node);
}

function finished(
  editor: GraphEditor,
  node: CFGInstruction,
  generator: GeneratorShape,
  stamp: Stamp,
): void {
  const held = heldFrame(node);
  const status = stamp(loadOf(generator.frame, GEN_STATUS_FIELD, held));
  editor.insertBefore(node, status);
  const done = stamp(irConstant(GEN_FINISHED));
  editor.insertBefore(node, done);
  const test = stamp(irInt32Compare("==", status, done));
  editor.insertBefore(node, test);
  editor.replaceAllUses(node, test);
  editor.remove(node);
}

function yielded(
  editor: GraphEditor,
  classes: ClassTable,
  node: CFGInstruction,
  generator: GeneratorShape,
  stamp: Stamp,
): void {
  const held = heldFrame(node);
  const value = stamp(loadOf(generator.frame, GEN_VALUE_FIELD, held));
  const carried = classes.shapeOf(fieldOf(generator.frame, GEN_VALUE_FIELD).declaredType);
  if (carried !== null) value.props[VALUE_CLASS_PROP] = carried.id;
  editor.insertBefore(node, value);
  editor.replaceAllUses(node, value);
  editor.remove(node);
}

function calledMember(node: CFGInstruction): string | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod !== true) return null;
  const callee = node.inputs[0];
  if (callee === undefined) return null;
  const member = propertyNameOf(callee);
  return member !== null && MEMBERS.has(member) ? member : null;
}

function steppedCall(node: CFGInstruction): CFGInstruction | null {
  if (calledMember(node) !== NEXT_MEMBER || node.inputs.length !== NO_ARGUMENTS) return null;
  const callee = node.inputs[0]!;
  return callee.inputs[0] === node.inputs[RECEIVER] ? node.inputs[RECEIVER]! : null;
}

function spilledInto(use: CFGInstruction, held: CFGInstruction, frame: string): boolean {
  if (use.type !== IR_STORE_FIELD || use.inputs[0] === held) return false;
  return use.props[FIELD_TYPE_PROP] === frame;
}

function iterationOnly(
  held: CFGInstruction,
  generator: GeneratorShape,
  aliases: Set<CFGInstruction>,
): boolean {
  if (aliases.has(held)) return true;
  aliases.add(held);
  for (const use of held.uses) {
    if (use.type === IR_PHI) {
      if (!iterationOnly(use, generator, aliases)) return false;
      continue;
    }
    if (PROTOCOL.has(use.type) && use.inputs[0] === held) continue;
    const member = propertyNameOf(use);
    if (member !== null && MEMBERS.has(member) && use.inputs[0] === held) continue;
    if (calledMember(use) !== null && use.inputs[RECEIVER] === held) continue;
    if (calleeNameOf(use) === generator.resume) continue;
    if (READS_FRAME.has(use.type) && use.inputs[0] === held) continue;
    if (spilledInto(use, held, generator.frame.name)) continue;
    return false;
  }
  return true;
}

function refuseEscapes(graph: CFGFunction, classes: ClassTable): void {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const name = calleeNameOf(node);
      const generator = name === null ? null : classes.generatorOf(name);
      if (generator === null || generator.resume === name) continue;
      if (iterationOnly(node, generator, new Set())) continue;
      throw new BackendLoweringError(
        `${name} is a generator, and the compiler can only walk one with for-of or next(); ` +
          `iterate it, or keep this part interpreted`,
      );
    }
  }
}

export function lowerGeneratorIteration(graph: CFGFunction): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  refuseEscapes(graph, classes);
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let lowered = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const stepping = steppedCall(node);
      if (stepping !== null) {
        const generator = producedBy(stepping, classes);
        if (generator === null) continue;
        editor.setInput(node, 0, stepping);
        stepped(editor, node, generator, stamp);
        lowered += 1;
        continue;
      }
      const member = propertyNameOf(node);
      if (member === VALUE_MEMBER || member === DONE_MEMBER) {
        const generator = producedBy(heldFrame(node), classes);
        if (generator === null) continue;
        if (member === VALUE_MEMBER) yielded(editor, classes, node, generator, stamp);
        else finished(editor, node, generator, stamp);
        lowered += 1;
        continue;
      }
      if (!PROTOCOL.has(node.type)) continue;
      const generator = producedBy(node, classes);
      if (generator === null) continue;
      if (node.type === IR_ITERATOR_INIT) {
        editor.replaceAllUses(node, heldFrame(node));
        editor.remove(node);
      } else if (node.type === IR_ITERATOR_NEXT) {
        stepped(editor, node, generator, stamp);
      } else if (node.type === IR_ITERATOR_DONE) {
        finished(editor, node, generator, stamp);
      } else {
        yielded(editor, classes, node, generator, stamp);
      }
      lowered += 1;
    }
  }
  if (lowered > 0) graph.rebuildUses();
  return lowered;
}
