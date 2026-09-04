import {
  irBranch,
  irCallBuiltin,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irJump,
  irSelect,
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
  STRING_TO_END,
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
import { isAsciiCharacterCode, BYTEWISE_PROP } from "../analyses/wide-text.js";

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
const ORDERED_PAIR = 2;

interface Site {
  readonly graph: CFGFunction;
  readonly editor: GraphEditor;
  readonly stamp: Stamp;
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction;
  readonly subject: CFGInstruction;
  readonly separator: number;
  readonly kept: Kept | null;
  readonly model: ArrayModel;
}

type Kept = { readonly count: number } | { readonly counting: CFGInstruction };

function keptFrom(limit: CFGInstruction | undefined, types: TypeInference): Kept | null | undefined {
  if (limit === undefined) return null;
  if (limit.type === IR_CONSTANT) {
    const value = limit.props.value;
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    return { count: Math.min(value >>> 0, STRING_TO_END) };
  }
  return types.typeOf(limit).kind === TypeKind.Smi ? { counting: limit } : undefined;
}

function separatorCode(value: CFGInstruction | undefined): number | null {
  if (value === undefined || value.type !== IR_CONSTANT) return null;
  const text = value.props.value;
  if (typeof text !== "string") return null;
  if (text.length === 0) return EVERY_CHARACTER;
  if (text.length !== SINGLE_CHARACTER) return null;
  const code = text.codePointAt(0)!;
  return isAsciiCharacterCode(code) ? code : null;
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

function bytewise(node: CFGInstruction): CFGInstruction {
  node.props[BYTEWISE_PROP] = true;
  return node;
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
  const given = node.inputs.slice(RECEIVER_AND_SEPARATOR);
  if (given.length === 0 || given.length > ORDERED_PAIR) return null;
  const separator = separatorCode(given[0]);
  if (separator === null) return null;
  const kept = keptFrom(given[1], types);
  if (kept === undefined) return null;
  const model = arrayModelForElement(classes, stringType());
  if (model === null) return null;
  return { graph, editor, stamp, node, callee, subject, separator, kept, model };
}

function keptBound(site: Site): CFGInstruction | null {
  const { kept } = site;
  if (kept === null) return null;
  if ("count" in kept) return ahead(site, irConstant(kept.count));
  const unlimited = ahead(site, irConstant(STRING_TO_END));
  const origin = ahead(site, irConstant(FIRST_INDEX));
  const negative = ahead(site, irInt32Compare(LESS_THAN, kept.counting, origin));
  return ahead(site, irSelect(negative, unlimited, kept.counting));
}

function lowerCharacters(site: Site, bound: CFGInstruction | null): void {
  const { graph, editor, node, stamp, subject, model } = site;
  const parts = emptyArray(editor, node, model, stamp);
  const counted = ahead(site, callOf(site, LENGTH_MEMBER, [subject]));
  const length =
    bound === null
      ? counted
      : ahead(
          site,
          irSelect(
            ahead(site, irInt32Compare(LESS_THAN, counted, bound)),
            counted,
            bound,
          ),
        );
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
  editor.removeIfDead(site.callee);
}

function lowerSite(site: Site): void {
  const bound = keptBound(site);
  if (site.separator === EVERY_CHARACTER) {
    lowerCharacters(site, bound);
    return;
  }
  const { graph, editor, node, stamp, subject, model } = site;
  const parts = emptyArray(editor, node, model, stamp);
  const length = bytewise(ahead(site, callOf(site, LENGTH_MEMBER, [subject])));
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
  const kept = bound === null ? null : stamp(addPhi(header, [origin]));
  const more = append(header, irInt32Compare(LESS_THAN, cursor, length), stamp);
  const scanning = kept === null ? body : graph.addBlock();
  append(header, irBranch(more, scanning, tail), stamp);
  link(header, scanning);
  link(header, tail);
  if (kept !== null) {
    const room = append(scanning, irInt32Compare(LESS_THAN, kept, bound!), stamp);
    append(scanning, irBranch(room, body, tail), stamp);
    link(scanning, body);
    link(scanning, tail);
  }

  const character = bytewise(callBuiltin(site, body, CHARACTER_AT, [subject, cursor]));
  const hit = append(body, irInt32Compare(EQUALS, character, wanted), stamp);
  append(body, irBranch(hit, cut, skip), stamp);
  link(body, cut);
  link(body, skip);

  const piece = bytewise(callBuiltin(site, cut, SLICE_MEMBER, [subject, start, cursor]));
  const cutJump = append(cut, irJump(advance), stamp);
  pushElement(editor, cutJump, parts, piece, model, stamp);
  const resumed = stamp(irInt32Add(cursor, step));
  resumed.props.noOverflow = true;
  editor.insertBefore(cutJump, resumed);
  const taken = kept === null ? null : stamp(irInt32Add(kept, step));
  if (taken !== null) {
    taken.props.noOverflow = true;
    editor.insertBefore(cutJump, taken);
  }
  append(skip, irJump(advance), stamp);

  const carried = stamp(addPhi(advance));
  const counted = kept === null ? null : stamp(addPhi(advance));
  connect(cut, advance, counted === null ? [resumed] : [resumed, taken!]);
  connect(skip, advance, counted === null ? [start] : [start, kept!]);
  const next = append(advance, irInt32Add(cursor, step), stamp);
  next.props.noOverflow = true;
  append(advance, irJump(header), stamp);
  link(advance, header);
  cursor.addInput(next);
  start.addInput(carried);
  if (kept !== null) kept.addInput(counted!);

  const tailed = kept === null ? tail : graph.addBlock();
  if (kept !== null) {
    const room = append(tail, irInt32Compare(LESS_THAN, kept, bound!), stamp);
    append(tail, irBranch(room, tailed, after), stamp);
    link(tail, tailed);
    link(tail, after);
  }
  const last = bytewise(callBuiltin(site, tailed, SLICE_MEMBER, [subject, start, length]));
  const tailJump = append(tailed, irJump(after), stamp);
  pushElement(editor, tailJump, parts, last, model, stamp);
  link(tailed, after);

  editor.replaceAllUses(node, parts);
  editor.remove(node);
  editor.removeIfDead(site.callee);
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
