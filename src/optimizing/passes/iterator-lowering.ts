import {
  type CFGFunction,
  type CFGInstruction,
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
  irLoadElement,
  irLoadArrayLength,
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
import { arrayModelOf } from "./array-shapes.js";
import { RANGE_BUILTIN } from "../metadata/builtin-methods.js";

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

type Sequence =
  | { readonly kind: "elements"; readonly array: CFGInstruction }
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

function countsInInt32(value: CFGInstruction, types: TypeInference): boolean {
  return aotScalarOf(types.typeOf(value)) === SCALAR_INT32;
}

function rangeBehind(call: CFGInstruction, types: TypeInference): Sequence | null {
  const callee = call.inputs[0];
  if (call.type !== IR_GENERIC_CALL || call.props.isMethod === true) return null;
  if (callee?.type !== IR_LOAD_GLOBAL || String(callee.props.name) !== RANGE_BUILTIN) return null;

  const args = call.inputs.slice(1);
  if (args.length === 0 || args.length > 3) return null;
  const step = args.length === 3 ? constantNumber(args[2]) : STEP;
  if (step === null || step === 0) return null;
  const start = args.length === 1 ? null : args[0]!;
  const stop = args.length === 1 ? args[0]! : args[1]!;
  if (!countsInInt32(stop, types)) return null;
  if (start !== null && !countsInInt32(start, types)) return null;
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
  const call = reachedThrough(
    iterable,
    THROUGH_ALIASES,
    (candidate) => candidate.type === IR_GENERIC_CALL,
  );
  if (call !== null) return rangeBehind(call, types);
  const classes = graph.classes;
  if (classes !== null && arrayModelOf(iterable, graph, classes, types) !== null) {
    return { kind: "elements", array: iterable };
  }
  const element = aotElementScalarOf(types.typeOf(iterable));
  if (element === null || isReferenceScalar(element)) return null;
  return { kind: "elements", array: iterable };
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
  return sequence.kind === "elements"
    ? elementsReplacement(editor, node, sequence, stamp)
    : rangeReplacement(editor, node, sequence, stamp);
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
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      const sequence = sequences.get(node);
      if (sequence === undefined || node.block !== block) continue;
      const replacement = replacementFor(editor, node, sequence, stamp);
      if (replacement.block === null) {
        replacement.frameState = node.frameState;
        editor.insertBefore(node, replacement);
      }
      editor.replaceAllUses(node, replacement);
      editor.remove(node);
      count++;
    }
  }
  for (const sequence of new Set(sequences.values())) {
    if (sequence.kind !== "range" || sequence.call.uses.length > 0) continue;
    const callee = sequence.call.inputs[0]!;
    editor.remove(sequence.call);
    if (callee.uses.length === 0) editor.remove(callee);
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
