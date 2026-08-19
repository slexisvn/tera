import {
  IR_CALL_BUILTIN,
  irBranch,
  irCallBuiltin,
  irConstant,
  irInt32Add,
  irInt32And,
  irInt32Compare,
  irInt32Or,
  irInt32Shr,
  irInt32Sub,
  irJump,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { link, splitBlockBefore } from "../ir/cfg-edit.js";
import type { GraphEditor } from "../ir/editor.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  THROW_BUILTIN,
} from "../metadata/builtin-methods.js";
import { INT32_BITS } from "../target/integer.js";
import type { DominatorTree } from "../analyses/dominance.js";

const SIGN_SHIFT = INT32_BITS - 1;
const ONE_PLACE = 1;
const ORIGIN = 0;
const LESS_THAN = "<";
const EQUALS = "==";
const RECEIVER = 0;

export type Stamp = (node: CFGInstruction) => CFGInstruction;

export function append(block: CFGBlock, node: CFGInstruction, stamp: Stamp): CFGInstruction {
  stamp(node);
  node.block = block;
  block.nodes.push(node);
  return node;
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

function computed(
  editor: GraphEditor,
  before: CFGInstruction,
  node: CFGInstruction,
  stamp: Stamp,
): CFGInstruction {
  const stamped = stamp(node);
  stamped.props.noOverflow = true;
  editor.insertBefore(before, stamped);
  return stamped;
}

function faultingBlock(
  graph: CFGFunction,
  origin: CFGInstruction,
  target: CFGBlock,
  message: string,
  stamp: Stamp,
): CFGBlock {
  const block = graph.addBlock();
  const text = append(block, irConstant(message), stamp);
  const intrinsic = builtinGlobalIntrinsicByName(THROW_BUILTIN)!;
  const raised = append(
    block,
    irCallBuiltin(THROW_BUILTIN, [text], builtinMethodCallMetadata(intrinsic)),
    stamp,
  );
  raised.frameState = origin.frameState;
  append(block, irJump(target), stamp);
  link(block, target);
  return block;
}

/** Diverts to a raised fault when `condition` holds, leaving `node` on the path that survives it. */
export function faultWhen(
  graph: CFGFunction,
  node: CFGInstruction,
  condition: CFGInstruction,
  message: string,
  stamp: Stamp,
): void {
  const entry = node.block!;
  const take = splitBlockBefore(graph, entry, node);
  const faulted = faultingBlock(graph, node, take, message, stamp);
  append(entry, irBranch(condition, faulted, take), stamp);
  link(entry, faulted);
  link(entry, take);
}

/**
 * A length the program already measured in a block strictly above this one, which keeps a
 * guarded call inside a loop from walking the text again on every turn. A measurement in
 * the node's own block is passed over: it may sit after the node, and ordering within a
 * block is not what the dominator tree answers.
 */
export function measuredAlready(
  node: CFGInstruction,
  measure: string,
  receiver: CFGInstruction,
  reaching: DominatorTree,
): CFGInstruction | null {
  const site = node.block;
  if (site === null) return null;
  for (const use of receiver.uses) {
    if (use.type !== IR_CALL_BUILTIN || use.props.name !== measure) continue;
    if (use.inputs[RECEIVER] !== receiver || use.block === null || use.block === site) continue;
    if (reaching.dominates(use.block, site)) return use;
  }
  return null;
}

/**
 * Tells whether `value` has left `[0, limit)`, or `[0, ∞)` where there is no limit.
 * Both ends are read off one sign bit, so the caller pays a single compare either way.
 */
function crossedBound(
  editor: GraphEditor,
  node: CFGInstruction,
  value: CFGInstruction,
  limit: CFGInstruction | null,
  stamp: Stamp,
): CFGInstruction {
  const none = constantAt(editor, node, ORIGIN, stamp);
  if (limit === null) {
    return computed(editor, node, irInt32Compare(LESS_THAN, value, none), stamp);
  }
  const step = constantAt(editor, node, ONE_PLACE, stamp);
  const last = computed(editor, node, irInt32Sub(limit, step), stamp);
  const remaining = computed(editor, node, irInt32Sub(last, value), stamp);
  const crossed = computed(editor, node, irInt32Or(value, remaining), stamp);
  return computed(editor, node, irInt32Compare(LESS_THAN, crossed, none), stamp);
}

/** Faults where `value` leaves `[0, limit)`, which a compiled call has no answer for. */
export function faultOutsideRange(
  graph: CFGFunction,
  editor: GraphEditor,
  node: CFGInstruction,
  value: CFGInstruction,
  limit: CFGInstruction | null,
  message: string,
  stamp: Stamp,
): void {
  faultWhen(graph, node, crossedBound(editor, node, value, limit, stamp), message, stamp);
}

/** Faults where `value` is zero, which the arithmetic around it cannot answer for. */
export function faultWhenZero(
  graph: CFGFunction,
  editor: GraphEditor,
  node: CFGInstruction,
  value: CFGInstruction,
  message: string,
  stamp: Stamp,
): void {
  const none = constantAt(editor, node, ORIGIN, stamp);
  const empty = computed(editor, node, irInt32Compare(EQUALS, value, none), stamp);
  faultWhen(graph, node, empty, message, stamp);
}

/**
 * Resolves a subscript the way the interpreter does: a negative index counts back from
 * the end of `length`, and anything still outside the string or array faults, because a
 * compiled program has no `undefined` to hand back for it.
 */
export function boundedIndex(
  graph: CFGFunction,
  editor: GraphEditor,
  node: CFGInstruction,
  index: CFGInstruction,
  length: CFGInstruction,
  message: string,
  stamp: Stamp,
): CFGInstruction {
  const shift = constantAt(editor, node, SIGN_SHIFT, stamp);
  const fromEnd = computed(editor, node, irInt32Shr(index, shift), stamp);
  const wrap = computed(editor, node, irInt32And(length, fromEnd), stamp);
  const resolved = computed(editor, node, irInt32Add(index, wrap), stamp);
  faultOutsideRange(graph, editor, node, resolved, length, message, stamp);
  return resolved;
}
