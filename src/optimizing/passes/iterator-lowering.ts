import {
  type CFGFunction,
  type CFGInstruction,
  IR_ITERATOR_DONE,
  IR_ITERATOR_INIT,
  IR_ITERATOR_NEXT,
  IR_ITERATOR_VALUE,
  IR_NEW_ARRAY,
  IR_PHI,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irLoadElement,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";

const BEFORE_FIRST = -1;
const STEP = 1;
const AT_END = ">=";

const ITERATOR_OPS: ReadonlySet<string> = new Set<string>([
  IR_ITERATOR_INIT,
  IR_ITERATOR_NEXT,
  IR_ITERATOR_DONE,
  IR_ITERATOR_VALUE,
]);

type Stamp = (node: CFGInstruction) => CFGInstruction;

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

function arrayBehind(node: CFGInstruction): CFGInstruction | null {
  const cursor = node.inputs[0];
  if (cursor === undefined) return null;
  const start =
    node.type === IR_ITERATOR_INIT
      ? cursor
      : reachedThrough(cursor, THROUGH_CURSORS, (candidate) => candidate.type === IR_ITERATOR_INIT)
          ?.inputs[0] ?? null;
  if (start === null) return null;
  return reachedThrough(start, THROUGH_ALIASES, (candidate) => candidate.type === IR_NEW_ARRAY);
}

function replacementFor(
  editor: GraphEditor,
  node: CFGInstruction,
  array: CFGInstruction,
  stamp: Stamp,
): CFGInstruction {
  if (node.type === IR_ITERATOR_INIT) return stamp(irConstant(BEFORE_FIRST));
  const cursor = node.inputs[0]!;
  if (node.type === IR_ITERATOR_VALUE) return stamp(irLoadElement(array, cursor));
  const stepping = node.type === IR_ITERATOR_NEXT;
  const operand = stamp(irConstant(stepping ? STEP : array.inputs.length));
  editor.insertBefore(node, operand);
  const cursorOp = stamp(
    stepping ? irInt32Add(cursor, operand) : irInt32Compare(AT_END, cursor, operand),
  );
  cursorOp.props.noOverflow = true;
  return cursorOp;
}

export function lowerIterators(graph: CFGFunction): number {
  const arrays = new Map<CFGInstruction, CFGInstruction>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!ITERATOR_OPS.has(node.type)) continue;
      const array = arrayBehind(node);
      if (array !== null) arrays.set(node, array);
    }
  }
  if (arrays.size === 0) return 0;

  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let count = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      const array = arrays.get(node);
      if (array === undefined || node.block !== block) continue;
      const replacement = replacementFor(editor, node, array, stamp);
      replacement.frameState = node.frameState;
      editor.insertBefore(node, replacement);
      editor.replaceAllUses(node, replacement);
      editor.remove(node);
      count++;
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
