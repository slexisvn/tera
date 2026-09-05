import {
  irBranch,
  irCallBuiltin,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irInt32Sub,
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
import { isAsciiCharacterCode, storesCodeUnits, BYTEWISE_PROP } from "../analyses/wide-text.js";

const SPLIT_MEMBER = "split";
const LENGTH_MEMBER = "length";
const CHARACTER_AT = "char_code_at";
const SLICE_MEMBER = "slice";
const FIRST_INDEX = 0;
const STEP = 1;
const EQUALS = "==";
const NOT_EQUAL = "!=";
const LESS_THAN = "<";
const RECEIVER_AND_SEPARATOR = 2;
const ORDERED_PAIR = 2;

type Separator =
  | { readonly kind: "every" }
  | { readonly kind: "codes"; readonly codes: readonly number[] }
  | { readonly kind: "value"; readonly text: CFGInstruction };

interface Site {
  readonly graph: CFGFunction;
  readonly editor: GraphEditor;
  readonly stamp: Stamp;
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction;
  readonly subject: CFGInstruction;
  readonly separator: Separator;
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

function separatorOf(
  value: CFGInstruction | undefined,
  matchesAnyUnit: boolean,
  types: TypeInference,
): Separator | null {
  if (value === undefined) return null;
  if (value.type !== IR_CONSTANT) {
    return types.typeOf(value).kind === TypeKind.String ? { kind: "value", text: value } : null;
  }
  const text = value.props.value;
  if (typeof text !== "string") return null;
  if (text.length === 0) return { kind: "every" };
  const codes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!matchesAnyUnit && !isAsciiCharacterCode(code)) return null;
    codes.push(code);
  }
  return { kind: "codes", codes };
}

function within(site: Site, block: CFGBlock, node: CFGInstruction): CFGInstruction {
  return placed(site, node, (added) => append(block, added, site.stamp));
}

function callBuiltin(
  site: Site,
  block: CFGBlock,
  member: string,
  args: readonly CFGInstruction[],
): CFGInstruction {
  return within(site, block, callOf(site, member, args));
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
  const separator = separatorOf(given[0], storesCodeUnits(graph), types);
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

interface Plan {
  readonly pieceStride: CFGInstruction;
  readonly scanStride: CFGInstruction;
  readonly tailGuard: CFGInstruction | null;
  match(
    body: CFGBlock,
    cursor: CFGInstruction,
    start: CFGInstruction,
    onMatch: CFGBlock,
    onMiss: CFGBlock,
  ): void;
}

function branchTo(
  site: Site,
  from: CFGBlock,
  test: CFGInstruction,
  taken: CFGBlock,
  missed: CFGBlock,
): void {
  append(from, irBranch(test, taken, missed), site.stamp);
  link(from, taken);
  link(from, missed);
}

function unitsPlan(site: Site, length: CFGInstruction, codes: readonly number[]): Plan {
  const width = ahead(site, irConstant(codes.length));
  const past = ahead(site, irInt32Sub(length, width));
  const limit =
    codes.length === STEP ? null : ahead(site, irInt32Add(past, ahead(site, irConstant(STEP))));
  return {
    pieceStride: width,
    scanStride: width,
    tailGuard: null,
    match(body, cursor, _start, onMatch, onMiss) {
      let from = body;
      if (limit !== null) {
        const room = within(site, from, irInt32Compare(LESS_THAN, cursor, limit));
        const scan = site.graph.addBlock();
        branchTo(site, from, room, scan, onMiss);
        from = scan;
      }
      for (let index = 0; index < codes.length; index += 1) {
        const at =
          index === FIRST_INDEX
            ? cursor
            : within(site, from, irInt32Add(cursor, within(site, from, irConstant(index))));
        const unit = bytewise(callBuiltin(site, from, CHARACTER_AT, [site.subject, at]));
        const wanted = within(site, from, irConstant(codes[index]!));
        const hit = within(site, from, irInt32Compare(EQUALS, unit, wanted));
        const next = index + STEP === codes.length ? onMatch : site.graph.addBlock();
        branchTo(site, from, hit, next, onMiss);
        from = next;
      }
    },
  };
}

function textPlan(site: Site, length: CFGInstruction, text: CFGInstruction): Plan {
  const { graph, stamp } = site;
  const width = bytewise(ahead(site, callOf(site, LENGTH_MEMBER, [text])));
  const one = ahead(site, irConstant(STEP));
  const origin = ahead(site, irConstant(FIRST_INDEX));
  const limit = ahead(site, irInt32Add(ahead(site, irInt32Sub(length, width)), one));
  const vacant = ahead(site, irInt32Compare(LESS_THAN, width, one));
  const spanned = ahead(site, irInt32Add(length, width));
  return {
    pieceStride: width,
    scanStride: ahead(site, irSelect(vacant, one, width)),
    tailGuard: ahead(site, irInt32Compare(NOT_EQUAL, spanned, origin)),
    match(body, cursor, start, onMatch, onMiss) {
      const scan = graph.addBlock();
      const compare = graph.addBlock();
      const step = graph.addBlock();
      const whole = graph.addBlock();
      const boundary = graph.addBlock();
      branchTo(site, body, within(site, body, irInt32Compare(LESS_THAN, cursor, limit)), scan, onMiss);

      const taken = stamp(addPhi(scan, [origin]));
      branchTo(site, scan, within(site, scan, irInt32Compare(LESS_THAN, taken, width)), compare, whole);

      const here = within(site, compare, irInt32Add(cursor, taken));
      const unit = bytewise(callBuiltin(site, compare, CHARACTER_AT, [site.subject, here]));
      const wanted = bytewise(callBuiltin(site, compare, CHARACTER_AT, [text, taken]));
      branchTo(site, compare, within(site, compare, irInt32Compare(EQUALS, unit, wanted)), step, onMiss);

      const advanced = within(site, step, irInt32Add(taken, one));
      advanced.props.noOverflow = true;
      append(step, irJump(scan), stamp);
      link(step, scan);
      taken.addInput(advanced);

      branchTo(site, whole, vacant, boundary, onMatch);
      branchTo(
        site,
        boundary,
        within(site, boundary, irInt32Compare(EQUALS, cursor, start)),
        onMiss,
        onMatch,
      );
    },
  };
}

type Gate = (block: CFGBlock) => CFGInstruction;

function gatesOf(
  site: Site,
  plan: Plan,
  kept: CFGInstruction | null,
  bound: CFGInstruction | null,
): Gate[] {
  const gates: Gate[] = [];
  const { tailGuard } = plan;
  if (tailGuard !== null) gates.push(() => tailGuard);
  if (kept !== null) {
    gates.push((block) => within(site, block, irInt32Compare(LESS_THAN, kept, bound!)));
  }
  return gates;
}

function planFor(
  site: Site,
  length: CFGInstruction,
  separator: Exclude<Separator, { kind: "every" }>,
): Plan {
  return separator.kind === "codes"
    ? unitsPlan(site, length, separator.codes)
    : textPlan(site, length, separator.text);
}

function lowerSite(site: Site): void {
  const bound = keptBound(site);
  const separator = site.separator;
  if (separator.kind === "every") {
    lowerCharacters(site, bound);
    return;
  }
  const { graph, editor, node, stamp, subject, model } = site;
  const parts = emptyArray(editor, node, model, stamp);
  const length = bytewise(ahead(site, callOf(site, LENGTH_MEMBER, [subject])));
  const origin = ahead(site, irConstant(FIRST_INDEX));
  const step = ahead(site, irConstant(STEP));
  const plan = planFor(site, length, separator);

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

  plan.match(body, cursor, start, cut, skip);

  const piece = bytewise(callBuiltin(site, cut, SLICE_MEMBER, [subject, start, cursor]));
  const cutJump = append(cut, irJump(advance), stamp);
  pushElement(editor, cutJump, parts, piece, model, stamp);
  const resumed = stamp(irInt32Add(cursor, plan.pieceStride));
  resumed.props.noOverflow = true;
  editor.insertBefore(cutJump, resumed);
  const taken = kept === null ? null : stamp(irInt32Add(kept, step));
  if (taken !== null) {
    taken.props.noOverflow = true;
    editor.insertBefore(cutJump, taken);
  }
  append(skip, irJump(advance), stamp);

  const carried = stamp(addPhi(advance));
  const strode = stamp(addPhi(advance));
  const counted = kept === null ? null : stamp(addPhi(advance));
  const cutArgs = [resumed, plan.scanStride];
  const skipArgs = [start, step];
  if (counted !== null) {
    cutArgs.push(taken!);
    skipArgs.push(kept!);
  }
  connect(cut, advance, cutArgs);
  connect(skip, advance, skipArgs);
  const next = append(advance, irInt32Add(cursor, strode), stamp);
  next.props.noOverflow = true;
  append(advance, irJump(header), stamp);
  link(advance, header);
  cursor.addInput(next);
  start.addInput(carried);
  if (kept !== null) kept.addInput(counted!);

  let tailed = tail;
  for (const gate of gatesOf(site, plan, kept, bound)) {
    const opened = graph.addBlock();
    branchTo(site, tailed, gate(tailed), opened, after);
    tailed = opened;
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
