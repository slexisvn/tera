import {
  type CFGFunction,
  type CFGInstruction,
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_ITERATOR_DONE,
  IR_ITERATOR_INIT,
  IR_ITERATOR_NEXT,
  IR_ITERATOR_VALUE,
  IR_LOAD_GLOBAL,
  IR_NEW_ARRAY,
  IR_PHI,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irInt32Sub,
  irGenericCall,
  irGenericGetProp,
  irLoadElement,
  irLoadArrayLength,
  rangeCallArguments,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  aotElementScalarOf,
  aotScalarOf,
  isReferenceScalar,
  SCALAR_INT32,
} from "../types/scalar.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { TypeKind } from "../types/lattice.js";
import { STEP_MEMBER, stepsItself } from "../metadata/class-table.js";
import { arrayModelOf } from "./array-shapes.js";

const BEFORE_FIRST = -1;
const STEP = 1;
const AT_END = ">=";
const BELOW_END = "<=";
const DEFAULT_START = 0;

const ITERATOR_OPS: ReadonlySet<string> = new Set<string>([
  IR_ITERATOR_INIT,
  IR_ITERATOR_NEXT,
  IR_ITERATOR_DONE,
  IR_ITERATOR_VALUE,
]);

type Stamp = (node: CFGInstruction) => CFGInstruction;

const STEP_DONE = "done";
const STEP_VALUE = "value";

type Sequence =
  | { readonly kind: "elements"; readonly array: CFGInstruction }
  | { readonly kind: "protocol"; readonly source: CFGInstruction }
  | {
      readonly kind: "range";
      readonly call: CFGInstruction;
      readonly start: CFGInstruction | null;
      readonly stop: CFGInstruction;
      readonly step: number;
    };

function reachedThrough(
  start: CFGInstruction,
  transparent: ReadonlySet<string>,
  found: (node: CFGInstruction) => boolean,
): CFGInstruction | null {
  const seen = new Set<CFGInstruction>();
  const pending = [start];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (found(node)) return node;
    if (transparent.has(node.type)) pending.push(...node.inputs);
  }
  return null;
}

const CALL_SHAPES: ReadonlySet<string> = new Set<string>([
  IR_GENERIC_CALL,
  IR_CALL_KNOWN_FUNCTION,
]);

const THROUGH_CURSORS: ReadonlySet<string> = new Set<string>([IR_ITERATOR_NEXT, IR_PHI]);
const THROUGH_ALIASES: ReadonlySet<string> = new Set<string>([IR_PHI]);

function iterableOf(node: CFGInstruction): CFGInstruction | null {
  const cursor = node.inputs[0];
  if (cursor === undefined) return null;
  if (node.type === IR_ITERATOR_INIT) return cursor;
  const init = reachedThrough(
    cursor,
    THROUGH_CURSORS,
    (candidate) => candidate.type === IR_ITERATOR_INIT,
  );
  return init?.inputs[0] ?? null;
}

function constantNumber(node: CFGInstruction | undefined): number | null {
  if (node?.type !== IR_CONSTANT) return null;
  const value = node.props.value;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function countsInInt32(
  value: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): boolean {
  if (aotScalarOf(types.typeOf(value)) === SCALAR_INT32) return true;
  if (value.type !== IR_LOAD_GLOBAL) return false;
  const name = value.props.name;
  if (typeof name !== "string") return false;
  return graph.classes?.globalOf(name)?.scalar === SCALAR_INT32;
}

function rangeBehind(
  call: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): Sequence | null {
  const args = rangeCallArguments(call);
  if (args === null) return null;
  if (args.length === 0 || args.length > 3) return null;
  const step = args.length === 3 ? constantNumber(args[2]) : STEP;
  if (step === null || step === 0) return null;
  const start = args.length === 1 ? null : args[0]!;
  const stop = args.length === 1 ? args[0]! : args[1]!;
  if (!countsInInt32(stop, graph, types)) return null;
  if (start !== null && !countsInInt32(start, graph, types)) return null;
  return { kind: "range", call, start, stop, step };
}

function sequenceBehind(
  node: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): Sequence | null {
  const iterable = iterableOf(node);
  if (iterable === null) return null;
  const allocation = reachedThrough(
    iterable,
    THROUGH_ALIASES,
    (candidate) => candidate.type === IR_NEW_ARRAY,
  );
  if (allocation !== null) return { kind: "elements", array: allocation };
  const call = reachedThrough(iterable, THROUGH_ALIASES, (candidate) =>
    CALL_SHAPES.has(candidate.type),
  );
  if (call !== null) {
    const counted = rangeBehind(call, graph, types);
    if (counted !== null) return counted;
  }
  const classes = graph.classes;
  if (classes !== null && arrayModelOf(iterable, graph, classes, types) !== null) {
    return { kind: "elements", array: iterable };
  }
  const stepping = protocolBehind(iterable, graph, types);
  if (stepping !== null) return stepping;
  const element = aotElementScalarOf(types.typeOf(iterable));
  if (element === null || isReferenceScalar(element)) return null;
  return { kind: "elements", array: iterable };
}


function protocolBehind(
  iterable: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): Sequence | null {
  const classes = graph.classes;
  if (classes === null) return null;
  const type = types.typeOf(iterable);
  if (type.kind !== TypeKind.Object || typeof type.map !== "number") return null;
  const shape = classes.shapeById(type.map);
  if (shape === null || !stepsItself(shape)) return null;
  return { kind: "protocol", source: iterable };
}

function protocolReplacement(
  editor: GraphEditor,
  node: CFGInstruction,
  sequence: Extract<Sequence, { kind: "protocol" }>,
  stamp: Stamp,
): CFGInstruction {
  if (node.type === IR_ITERATOR_INIT) return stamp(irConstant(null));
  const held = node.inputs[0]!;
  if (node.type === IR_ITERATOR_NEXT) {
    const callee = stamp(irGenericGetProp(sequence.source, STEP_MEMBER));
    callee.frameState = node.frameState;
    editor.insertBefore(node, callee);
    const call = stamp(irGenericCall(callee, [sequence.source]));
    call.props.isMethod = true;
    call.frameState = node.frameState;
    return call;
  }
  const member = node.type === IR_ITERATOR_DONE ? STEP_DONE : STEP_VALUE;
  const read = stamp(irGenericGetProp(held, member));
  read.frameState = node.frameState;
  return read;
}

function rangeStart(
  editor: GraphEditor,
  node: CFGInstruction,
  sequence: Extract<Sequence, { kind: "range" }>,
  stamp: Stamp,
): CFGInstruction {
  const given = sequence.start;
  const first = given === null ? DEFAULT_START : constantNumber(given);
  if (first !== null) return stamp(irConstant(first - sequence.step));
  const step = stamp(irConstant(sequence.step));
  editor.insertBefore(node, step);
  const before = stamp(irInt32Sub(given!, step));
  before.props.noOverflow = true;
  return before;
}

function rangeReplacement(
  editor: GraphEditor,
  node: CFGInstruction,
  sequence: Extract<Sequence, { kind: "range" }>,
  stamp: Stamp,
): CFGInstruction {
  if (node.type === IR_ITERATOR_INIT) return rangeStart(editor, node, sequence, stamp);
  const cursor = node.inputs[0]!;
  if (node.type === IR_ITERATOR_VALUE) return cursor;
  if (node.type === IR_ITERATOR_DONE) {
    const past = stamp(
      irInt32Compare(sequence.step > 0 ? AT_END : BELOW_END, cursor, sequence.stop),
    );
    past.props.noOverflow = true;
    return past;
  }
  const step = stamp(irConstant(sequence.step));
  editor.insertBefore(node, step);
  const stepped = stamp(irInt32Add(cursor, step));
  stepped.props.noOverflow = true;
  return stepped;
}

function elementsReplacement(
  editor: GraphEditor,
  node: CFGInstruction,
  sequence: Extract<Sequence, { kind: "elements" }>,
  stamp: Stamp,
): CFGInstruction {
  if (node.type === IR_ITERATOR_INIT) return stamp(irConstant(BEFORE_FIRST));
  const cursor = node.inputs[0]!;
  if (node.type === IR_ITERATOR_VALUE) return stamp(irLoadElement(sequence.array, cursor));
  if (node.type === IR_ITERATOR_NEXT) {
    const step = stamp(irConstant(STEP));
    editor.insertBefore(node, step);
    const stepped = stamp(irInt32Add(cursor, step));
    stepped.props.noOverflow = true;
    return stepped;
  }
  const limit = stamp(irLoadArrayLength(sequence.array));
  editor.insertBefore(node, limit);
  const past = stamp(irInt32Compare(AT_END, cursor, limit));
  past.props.noOverflow = true;
  return past;
}

function replacementFor(
  editor: GraphEditor,
  node: CFGInstruction,
  sequence: Sequence,
  stamp: Stamp,
): CFGInstruction {
  if (sequence.kind === "elements") return elementsReplacement(editor, node, sequence, stamp);
  if (sequence.kind === "protocol") return protocolReplacement(editor, node, sequence, stamp);
  return rangeReplacement(editor, node, sequence, stamp);
}

function settled(
  value: CFGInstruction,
  replacements: ReadonlyMap<CFGInstruction, CFGInstruction>,
): CFGInstruction {
  let carried = value;
  const seen = new Set<CFGInstruction>();
  for (;;) {
    const next = replacements.get(carried);
    if (next === undefined || seen.has(carried)) return carried;
    seen.add(carried);
    carried = next;
  }
}

function asSettled(
  sequence: Sequence,
  replacements: ReadonlyMap<CFGInstruction, CFGInstruction>,
): Sequence {
  if (replacements.size === 0) return sequence;
  if (sequence.kind === "elements") {
    return { kind: "elements", array: settled(sequence.array, replacements) };
  }
  if (sequence.kind === "protocol") {
    return { kind: "protocol", source: settled(sequence.source, replacements) };
  }
  return {
    ...sequence,
    start: sequence.start === null ? null : settled(sequence.start, replacements),
    stop: settled(sequence.stop, replacements),
  };
}

export function lowerIterators(graph: CFGFunction, types: TypeInference): number {
  const sequences = new Map<CFGInstruction, Sequence>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!ITERATOR_OPS.has(node.type)) continue;
      const sequence = sequenceBehind(node, graph, types);
      if (sequence !== null) sequences.set(node, sequence);
    }
  }
  if (sequences.size === 0) return 0;

  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  const replacements = new Map<CFGInstruction, CFGInstruction>();
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      const sequence = sequences.get(node);
      if (sequence === undefined || node.block !== block) continue;
      const replacement = replacementFor(editor, node, asSettled(sequence, replacements), stamp);
      if (replacement.block === null) {
        replacement.frameState = node.frameState;
        editor.insertBefore(node, replacement);
      }
      editor.replaceAllUses(node, replacement);
      editor.remove(node);
      replacements.set(node, replacement);
      count++;
    }
  }
  for (const sequence of new Set(sequences.values())) {
    if (sequence.kind !== "range" || sequence.call.uses.length > 0) continue;
    const operands = [...sequence.call.inputs];
    editor.remove(sequence.call);
    for (const operand of operands) editor.removeIfDead(operand);
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
