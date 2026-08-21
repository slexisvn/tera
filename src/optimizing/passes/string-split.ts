import {
  irBranch,
  irCallBuiltin,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irJump,
  IR_CONSTANT,
  memberCalled,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicFor,
} from "../metadata/builtin-methods.js";
import type { ClassTable } from "../metadata/class-table.js";
import { stringType, TypeKind } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";
import {
  arrayModelForElement,
  emptyArray,
  pushElement,
  type ArrayModel,
} from "./array-shapes.js";
import { append, type Stamp } from "./guards.js";

const SPLIT_MEMBER = "split";
const LENGTH_MEMBER = "length";
const CHARACTER_AT = "char_code_at";
const SLICE_MEMBER = "slice";
const SINGLE_CHARACTER = 1;
const EVERY_CHARACTER = -1;
const FIRST_INDEX = 0;
const STEP = 1;
const EQUALS = "==";
const LESS_THAN = "<";
const RECEIVER_AND_SEPARATOR = 2;

interface Site {
  readonly graph: CFGFunction;
  readonly editor: GraphEditor;
  readonly stamp: Stamp;
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction;
  readonly subject: CFGInstruction;
  readonly separator: number;
  readonly model: ArrayModel;
}

function separatorCode(value: CFGInstruction | undefined): number | null {
  if (value === undefined || value.type !== IR_CONSTANT) return null;
  const text = value.props.value;
  if (typeof text !== "string") return null;
  if (text.length === 0) return EVERY_CHARACTER;
  return text.length === SINGLE_CHARACTER ? text.codePointAt(0)! : null;
}

function callBuiltin(
  site: Site,
  block: CFGBlock,
  member: string,
  args: readonly CFGInstruction[],
): CFGInstruction {
  return placed(site, callOf(site, member, args), (added) => append(block, added, site.stamp));
}

function callOf(
  site: Site,
  member: string,
  args: readonly CFGInstruction[],
): CFGInstruction {
  const intrinsic = builtinMethodIntrinsicFor(stringType(), member)!;
  return irCallBuiltin(intrinsic.qualifiedName, [...args], builtinMethodCallMetadata(intrinsic));
}

function placed(
  site: Site,
  node: CFGInstruction,
  emit: (added: CFGInstruction) => void,
): CFGInstruction {
  site.stamp(node);
  node.frameState = site.node.frameState;
  emit(node);
  return node;
}

function ahead(site: Site, node: CFGInstruction): CFGInstruction {
  return placed(site, node, (added) => site.editor.insertBefore(site.node, added));
}

function siteOf(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  editor: GraphEditor,
  stamp: Stamp,
): Site | null {
  const callee = memberCalled(node, SPLIT_MEMBER);
  if (callee === null) return null;
  const subject = node.inputs[1];
  if (subject === undefined || types.typeOf(subject).kind !== TypeKind.String) return null;
  if (node.inputs.length !== RECEIVER_AND_SEPARATOR + 1) return null;
  const separator = separatorCode(node.inputs[2]);
  if (separator === null) return null;
  const model = arrayModelForElement(classes, stringType());
  if (model === null) return null;
  return { graph, editor, stamp, node, callee, subject, separator, model };
}

function lowerCharacters(site: Site): void {
  const { graph, editor, node, stamp, subject, model } = site;
  const parts = emptyArray(editor, node, model, stamp);
  const length = ahead(site, callOf(site, LENGTH_MEMBER, [subject]));
  const origin = ahead(site, irConstant(FIRST_INDEX));
  const step = ahead(site, irConstant(STEP));

  const entry = node.block!;
  const after = splitBlockBefore(graph, entry, node);
  const header = graph.addBlock();
  const body = graph.addBlock();

  append(entry, irJump(header), stamp);
  link(entry, header);

  const cursor = stamp(addPhi(header, [origin]));
  const more = append(header, irInt32Compare(LESS_THAN, cursor, length), stamp);
  append(header, irBranch(more, body, after), stamp);
  link(header, body);
  link(header, after);

  const next = append(body, irInt32Add(cursor, step), stamp);
  next.props.noOverflow = true;
  const piece = callBuiltin(site, body, SLICE_MEMBER, [subject, cursor, next]);
  const bodyJump = append(body, irJump(header), stamp);
  pushElement(editor, bodyJump, parts, piece, model, stamp);
  link(body, header);
  cursor.addInput(next);

  editor.replaceAllUses(node, parts);
  editor.remove(node);
  if (site.callee.uses.length === 0) editor.remove(site.callee);
}

function lowerSite(site: Site): void {
  if (site.separator === EVERY_CHARACTER) {
    lowerCharacters(site);
    return;
  }
  const { graph, editor, node, stamp, subject, model } = site;
  const parts = emptyArray(editor, node, model, stamp);
  const length = ahead(site, callOf(site, LENGTH_MEMBER, [subject]));
  const origin = ahead(site, irConstant(FIRST_INDEX));
  const wanted = ahead(site, irConstant(site.separator));
  const step = ahead(site, irConstant(STEP));

  const entry = node.block!;
  const after = splitBlockBefore(graph, entry, node);
  const header = graph.addBlock();
  const body = graph.addBlock();
  const cut = graph.addBlock();
  const skip = graph.addBlock();
  const advance = graph.addBlock();
  const tail = graph.addBlock();

  append(entry, irJump(header), stamp);
  link(entry, header);

  const cursor = stamp(addPhi(header, [origin]));
  const start = stamp(addPhi(header, [origin]));
  const more = append(header, irInt32Compare(LESS_THAN, cursor, length), stamp);
  append(header, irBranch(more, body, tail), stamp);
  link(header, body);
  link(header, tail);

  const character = callBuiltin(site, body, CHARACTER_AT, [subject, cursor]);
  const hit = append(body, irInt32Compare(EQUALS, character, wanted), stamp);
  append(body, irBranch(hit, cut, skip), stamp);
  link(body, cut);
  link(body, skip);

  const piece = callBuiltin(site, cut, SLICE_MEMBER, [subject, start, cursor]);
  const cutJump = append(cut, irJump(advance), stamp);
  pushElement(editor, cutJump, parts, piece, model, stamp);
  const resumed = stamp(irInt32Add(cursor, step));
  resumed.props.noOverflow = true;
  editor.insertBefore(cutJump, resumed);
  append(skip, irJump(advance), stamp);

  const carried = stamp(addPhi(advance));
  connect(cut, advance, [resumed]);
  connect(skip, advance, [start]);
  const next = append(advance, irInt32Add(cursor, step), stamp);
  next.props.noOverflow = true;
  append(advance, irJump(header), stamp);
  link(advance, header);
  cursor.addInput(next);
  start.addInput(carried);

  const last = callBuiltin(site, tail, SLICE_MEMBER, [subject, start, length]);
  const tailJump = append(tail, irJump(after), stamp);
  pushElement(editor, tailJump, parts, last, model, stamp);
  link(tail, after);

  editor.replaceAllUses(node, parts);
  editor.remove(node);
  if (site.callee.uses.length === 0) editor.remove(site.callee);
}

export function lowerStringSplit(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let lowered = 0;
  for (let index = 0; index < graph.blocks.length; index += 1) {
    const block = graph.blocks[index]!;
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const site = siteOf(node, graph, classes, types, editor, stamp);
      if (site === null) continue;
      lowerSite(site);
      lowered += 1;
    }
  }
  if (lowered > 0) graph.rebuildUses();
  return lowered;
}
