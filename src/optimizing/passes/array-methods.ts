import {
  irBranch,
  irFloat64Compare,
  irGenericCompare,
  irInt32Add,
  irInt32Compare,
  irJump,
  irLoadElement,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import type { TypeInference } from "../analyses/type-inference.js";
import {
  arrayModelOf,
  constantAt,
  describeElement,
  loadBuffer,
  loadCount,
  memberCalled,
  type ArrayModel,
  type Stamp,
} from "./array-shapes.js";
import { ARRAY_LENGTH_OFFSET } from "../metadata/class-table.js";
import { SCALAR_FLOAT64, SCALAR_INT32, type AotScalar } from "../types/scalar.js";

const CALLEE_AND_RECEIVER = 2;
const ONE_ARGUMENT = 1;
const FIRST_INDEX = 0;
const NOT_FOUND = -1;
const STEP = 1;
const EQUALS = "==";
const LESS_THAN = "<";
const GREATER_THAN = ">";

/** Both members scan for the value; `includes` reports the index as a boolean. */
interface Search {
  readonly member: string;
  readonly asBoolean: boolean;
}

const SEARCHES: readonly Search[] = [
  { member: "index_of", asBoolean: false },
  { member: "includes", asBoolean: true },
];

function comparison(
  element: AotScalar,
  left: CFGInstruction,
  right: CFGInstruction,
): CFGInstruction {
  if (element === SCALAR_INT32) return irInt32Compare(EQUALS, left, right);
  if (element === SCALAR_FLOAT64) return irFloat64Compare(EQUALS, left, right);
  return irGenericCompare(EQUALS, left, right);
}

function append(block: CFGBlock, node: CFGInstruction, stamp: Stamp): CFGInstruction {
  stamp(node);
  node.block = block;
  block.nodes.push(node);
  return node;
}

function searchFor(node: CFGInstruction): Search | null {
  if (node.inputs.length - CALLEE_AND_RECEIVER !== ONE_ARGUMENT) return null;
  return SEARCHES.find((candidate) => memberCalled(node, candidate.member) !== null) ?? null;
}

/**
 * Rewrites `array.index_of(value)` / `array.includes(value)` into a scan of the
 * elements, leaving the answer as a phi in the block the call used to sit in.
 */
function replaceSearch(
  graph: CFGFunction,
  editor: GraphEditor,
  node: CFGInstruction,
  callee: CFGInstruction,
  model: ArrayModel,
  search: Search,
  stamp: Stamp,
): void {
  const entry = node.block!;
  const array = node.inputs[1]!;
  const wanted = node.inputs[2]!;

  const length = loadCount(editor, node, array, ARRAY_LENGTH_OFFSET, model, stamp);
  const buffer = loadBuffer(editor, node, array, model, stamp);
  const start = constantAt(editor, node, FIRST_INDEX, stamp);
  const step = constantAt(editor, node, STEP, stamp);
  const missing = constantAt(editor, node, NOT_FOUND, stamp);

  const after = splitBlockBefore(graph, entry, node);
  const header = graph.addBlock();
  const body = graph.addBlock();
  const advance = graph.addBlock();
  const hit = graph.addBlock();
  const miss = graph.addBlock();

  append(entry, irJump(header), stamp);
  link(entry, header);

  const cursor = stamp(addPhi(header, [start]));
  const more = append(header, irInt32Compare(LESS_THAN, cursor, length), stamp);
  append(header, irBranch(more, body, miss), stamp);
  link(header, body);
  link(header, miss);

  const element = append(body, irLoadElement(buffer, cursor), stamp);
  describeElement(element, model);
  element.props.elementRep = model.element;
  element.frameState = node.frameState;
  const same = append(body, comparison(model.element, element, wanted), stamp);
  append(body, irBranch(same, hit, advance), stamp);
  link(body, hit);
  link(body, advance);

  const next = append(advance, irInt32Add(cursor, step), stamp);
  next.props.noOverflow = true;
  append(advance, irJump(header), stamp);
  link(advance, header);
  cursor.addInput(next);

  append(hit, irJump(after), stamp);
  append(miss, irJump(after), stamp);

  const found = stamp(addPhi(after));
  connect(hit, after, [cursor]);
  connect(miss, after, [missing]);

  let result = found;
  if (search.asBoolean) {
    const none = constantAt(editor, node, NOT_FOUND, stamp);
    result = stamp(irInt32Compare(GREATER_THAN, found, none));
    editor.insertBefore(node, result);
  }
  editor.replaceAllUses(node, result);
  editor.remove(node);
  if (callee.uses.length === 0) editor.remove(callee);
}

export function lowerArrayMethods(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let changed = 0;

  for (let index = 0; index < graph.blocks.length; index++) {
    const block = graph.blocks[index]!;
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const search = searchFor(node);
      if (search === null) continue;
      const model = arrayModelOf(node.inputs[1], graph, classes, types);
      if (model === null) continue;
      replaceSearch(graph, editor, node, memberCalled(node, search.member)!, model, search, stamp);
      changed++;
      break;
    }
  }
  if (changed > 0) graph.rebuildUses();
  return changed;
}
