import {
  CFGInstruction as IRNode,
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_LOAD_GLOBAL,
  irBranch,
  irFloat64Compare,
  irGenericAdd,
  irGenericCompare,
  irInt32Add,
  irCallBuiltin,
  irConstant,
  irInt32Compare,
  irInt32Shr,
  irInt32Sub,
  irJump,
  irLoadElement,
  irStoreElement,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  type IRMetadataValue,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import type { TypeInference } from "../analyses/type-inference.js";
import type { DeclaredSignature } from "../types/signature.js";
import { nominalLatticeType } from "../types/declared.js";
import {
  arrayModelForElement,
  arrayModelOf,
  constantAt,
  elementAccess,
  emptyArray,
  pushElement,
  storeCount,
  describeElement,
  loadBuffer,
  loadCount,
  memberCalled,
  type ArrayModel,
  type Stamp,
} from "./array-shapes.js";
import { ARRAY_LENGTH_OFFSET } from "../metadata/class-table.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  builtinMethodIntrinsicFor,
  THROW_BUILTIN,
  TO_STRING_MEMBER,
} from "../metadata/builtin-methods.js";
import { doubleType, smiType, stringType, type LatticeType } from "../types/lattice.js";
import {
  aotScalarOf,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  type AotScalar,
} from "../types/scalar.js";

const CALLEE_AND_RECEIVER = 2;
const ONE_ARGUMENT = 1;
const FIRST_INDEX = 0;
const NOT_FOUND = -1;
const STEP = 1;
const EQUALS = "==";
const LESS_THAN = "<";
const GREATER_THAN = ">";
const ELEMENT_ONLY = 1;
const ELEMENT_AND_INDEX = 2;
const ACCUMULATOR_AND_ELEMENT = 2;
const ACCUMULATOR_ELEMENT_AND_INDEX = 3;
const NO_ARGUMENTS = 0;
const EMPTY_LENGTH = 0;
const EMPTY_POP = "cannot pop an empty array";
const ORDERED_PAIR = 2;
const EMPTY_TEXT = "";
const DEFAULT_SEPARATOR = ",";
const AT_LEAST = ">=";

interface Scan {
  readonly after: CFGBlock;
  readonly origin: CFGInstruction;
  readonly header: CFGBlock;
  readonly body: CFGBlock;
  readonly advance: CFGBlock;
  readonly exhausted: CFGBlock;
  readonly cursor: CFGInstruction;
  readonly missing: CFGInstruction;
  readonly buffer: CFGInstruction;
}

interface Callback {
  readonly name: string;
  readonly signature: DeclaredSignature;
  readonly source: CFGInstruction;
}

interface Site {
  readonly graph: CFGFunction;
  readonly editor: GraphEditor;
  readonly node: CFGInstruction;
  readonly callee: CFGInstruction;
  readonly model: ArrayModel;
  readonly stamp: Stamp;
}

type Lowering = (site: Site) => boolean;

/** `index_of` reports the position, `includes` reports whether there was one. */
interface Search {
  readonly asBoolean: boolean;
}

interface Predicate {
  readonly stopsWhenTrue: boolean;
  readonly comparison: string | null;
}

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

function argumentsOf(node: CFGInstruction): CFGInstruction[] {
  return node.inputs.slice(CALLEE_AND_RECEIVER);
}

function calledFunctionName(source: CFGInstruction): string | null {
  if (source.type === IR_LOAD_GLOBAL) {
    const name = source.props.name;
    return typeof name === "string" ? name : null;
  }
  if (source.type !== IR_CONSTANT) return null;
  return compiledFunctionConstant(source.props.value)?.name ?? null;
}

function callbackAt(site: Site, index: number): Callback | null {
  const source = argumentsOf(site.node)[index];
  if (source === undefined) return null;
  const name = calledFunctionName(source);
  if (name === null) return null;
  const signature = site.graph.calleeSignatures?.get(name);
  if (signature === undefined || signature.variadic === true) return null;
  return { name, signature, source };
}

function suppliedArguments(
  callback: Callback,
  available: readonly CFGInstruction[],
  least: number,
): CFGInstruction[] | null {
  const arity = callback.signature.params.length;
  if (arity < least || arity > available.length) return null;
  return available.slice(0, arity);
}

function invoke(
  site: Site,
  block: CFGBlock,
  callback: Callback,
  args: readonly CFGInstruction[],
): CFGInstruction {
  const call = new IRNode(IR_CALL_KNOWN_FUNCTION, {
    target: {
      name: callback.name,
      declaredSignature: callback.signature,
    } as unknown as IRMetadataValue,
    argCount: args.length,
  });
  for (const argument of args) call.addInput(argument);
  call.frameState = site.node.frameState;
  return append(block, call, site.stamp);
}

function openScan(site: Site, boundOf: ((length: CFGInstruction) => CFGInstruction) | null = null): Scan {
  const { graph, editor, node, model, stamp } = site;
  const entry = node.block!;
  const array = node.inputs[1]!;

  const counted = loadCount(editor, node, array, ARRAY_LENGTH_OFFSET, model, stamp);
  const length = boundOf === null ? counted : boundOf(counted);
  const buffer = loadBuffer(editor, node, array, model, stamp);
  const start = constantAt(editor, node, FIRST_INDEX, stamp);
  const step = constantAt(editor, node, STEP, stamp);
  const missing = constantAt(editor, node, NOT_FOUND, stamp);

  const after = splitBlockBefore(graph, entry, node);
  const header = graph.addBlock();
  const body = graph.addBlock();
  const advance = graph.addBlock();
  const exhausted = graph.addBlock();

  append(entry, irJump(header), stamp);
  link(entry, header);

  const cursor = stamp(addPhi(header, [start]));
  const more = append(header, irInt32Compare(LESS_THAN, cursor, length), stamp);
  append(header, irBranch(more, body, exhausted), stamp);
  link(header, body);
  link(header, exhausted);

  const next = append(advance, irInt32Add(cursor, step), stamp);
  next.props.noOverflow = true;
  append(advance, irJump(header), stamp);
  link(advance, header);
  cursor.addInput(next);

  return { after, origin: start, header, body, advance, exhausted, cursor, missing, buffer };
}

function stopOn(site: Site, scan: Scan, test: CFGInstruction, whenTrue: boolean): CFGBlock {
  const stop = site.graph.addBlock();
  const taken = whenTrue ? stop : scan.advance;
  const untaken = whenTrue ? scan.advance : stop;
  append(scan.body, irBranch(test, taken, untaken), site.stamp);
  link(scan.body, taken);
  link(scan.body, untaken);
  append(stop, irJump(scan.after), site.stamp);
  return stop;
}

function indexReached(site: Site, scan: Scan, stop: CFGBlock): CFGInstruction {
  append(scan.exhausted, irJump(scan.after), site.stamp);
  const found = site.stamp(addPhi(scan.after));
  connect(stop, scan.after, [scan.cursor]);
  connect(scan.exhausted, scan.after, [scan.missing]);
  return found;
}

function comparedWithMissing(
  site: Site,
  found: CFGInstruction,
  operator: string,
): CFGInstruction {
  const none = constantAt(site.editor, site.node, NOT_FOUND, site.stamp);
  const result = site.stamp(irInt32Compare(operator, found, none));
  site.editor.insertBefore(site.node, result);
  return result;
}

function retire(site: Site, sources: readonly CFGInstruction[]): void {
  site.editor.remove(site.node);
  if (site.callee.uses.length === 0) site.editor.remove(site.callee);
  for (const source of sources) {
    if (source.uses.length === 0) site.editor.remove(source);
  }
}

function replaceWith(
  site: Site,
  result: CFGInstruction,
  sources: readonly CFGInstruction[],
): void {
  site.editor.replaceAllUses(site.node, result);
  retire(site, sources);
}

/**
 * Rewrites `array.index_of(value)` / `array.includes(value)` into a scan of the
 * elements, leaving the answer as a phi in the block the call used to sit in.
 */
function lowerSearch(site: Site, search: Search): boolean {
  const wanted = argumentsOf(site.node);
  if (wanted.length !== ONE_ARGUMENT) return false;

  const scan = openScan(site);
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  const same = append(scan.body, comparison(site.model.element, element, wanted[0]!), site.stamp);
  const stop = stopOn(site, scan, same, true);
  const found = indexReached(site, scan, stop);

  replaceWith(site, search.asBoolean ? comparedWithMissing(site, found, GREATER_THAN) : found, []);
  return true;
}

function lowerPredicate(site: Site, predicate: Predicate): boolean {
  if (argumentsOf(site.node).length !== ONE_ARGUMENT) return false;
  const callback = callbackAt(site, 0);
  if (callback === null) return false;
  const arity = callback.signature.params.length;
  if (arity < ELEMENT_ONLY || arity > ELEMENT_AND_INDEX) return false;

  const scan = openScan(site);
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  const args = suppliedArguments(callback, [element, scan.cursor], ELEMENT_ONLY)!;
  const test = invoke(site, scan.body, callback, args);
  const stop = stopOn(site, scan, test, predicate.stopsWhenTrue);
  const found = indexReached(site, scan, stop);
  const result =
    predicate.comparison === null ? found : comparedWithMissing(site, found, predicate.comparison);

  replaceWith(site, result, [callback.source]);
  return true;
}

function lowerForEach(site: Site): boolean {
  if (site.node.uses.length > 0) return false;
  if (argumentsOf(site.node).length !== ONE_ARGUMENT) return false;
  const callback = callbackAt(site, 0);
  if (callback === null) return false;
  const arity = callback.signature.params.length;
  if (arity < ELEMENT_ONLY || arity > ELEMENT_AND_INDEX) return false;

  const scan = openScan(site);
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  invoke(site, scan.body, callback, suppliedArguments(callback, [element, scan.cursor], ELEMENT_ONLY)!);
  append(scan.body, irJump(scan.advance), site.stamp);
  link(scan.body, scan.advance);
  append(scan.exhausted, irJump(scan.after), site.stamp);
  connect(scan.exhausted, scan.after);

  retire(site, [callback.source]);
  return true;
}

function lowerReduce(site: Site): boolean {
  const args = argumentsOf(site.node);
  const initial = args[1];
  if (args.length !== ACCUMULATOR_AND_ELEMENT || initial === undefined) return false;
  const callback = callbackAt(site, 0);
  if (callback === null) return false;
  const arity = callback.signature.params.length;
  if (arity < ACCUMULATOR_AND_ELEMENT || arity > ACCUMULATOR_ELEMENT_AND_INDEX) return false;

  const scan = openScan(site);
  const carried = site.stamp(addPhi(scan.header, [initial]));
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  const folded = invoke(
    site,
    scan.body,
    callback,
    suppliedArguments(callback, [carried, element, scan.cursor], ACCUMULATOR_AND_ELEMENT)!,
  );
  append(scan.body, irJump(scan.advance), site.stamp);
  link(scan.body, scan.advance);
  carried.addInput(folded);
  append(scan.exhausted, irJump(scan.after), site.stamp);
  connect(scan.exhausted, scan.after);

  replaceWith(site, carried, [callback.source]);
  return true;
}

function appendLoad(
  site: Site,
  block: CFGBlock,
  buffer: CFGInstruction,
  index: CFGInstruction,
): CFGInstruction {
  const load = append(block, irLoadElement(buffer, index), site.stamp);
  describeElement(load, site.model);
  load.props.elementRep = site.model.element;
  load.frameState = site.node.frameState;
  return load;
}

function appendStore(
  site: Site,
  block: CFGBlock,
  buffer: CFGInstruction,
  index: CFGInstruction,
  value: CFGInstruction,
): CFGInstruction {
  const store = append(block, irStoreElement(buffer, index, value), site.stamp);
  describeElement(store, site.model);
  store.frameState = site.node.frameState;
  return store;
}

function offsetBy(site: Site, block: CFGBlock, index: CFGInstruction, step: CFGInstruction, forward: boolean): CFGInstruction {
  const moved = append(block, forward ? irInt32Add(index, step) : irInt32Sub(index, step), site.stamp);
  moved.props.noOverflow = true;
  return moved;
}

function describedLoad(
  site: Site,
  anchor: CFGInstruction,
  buffer: CFGInstruction,
  index: CFGInstruction,
): CFGInstruction {
  const load = elementAccess(
    site.editor,
    anchor,
    irLoadElement(buffer, index),
    site.model,
    site.stamp,
  );
  load.props.elementRep = site.model.element;
  return load;
}

function faultingBlock(site: Site, target: CFGBlock, message: string): CFGBlock {
  const block = site.graph.addBlock();
  const text = append(block, irConstant(message), site.stamp);
  const intrinsic = builtinGlobalIntrinsicByName(THROW_BUILTIN)!;
  const raised = append(
    block,
    irCallBuiltin(THROW_BUILTIN, [text], builtinMethodCallMetadata(intrinsic)),
    site.stamp,
  );
  raised.frameState = site.node.frameState;
  append(block, irJump(target), site.stamp);
  link(block, target);
  return block;
}

function lowerPop(site: Site): boolean {
  if (argumentsOf(site.node).length !== NO_ARGUMENTS) return false;
  const { graph, editor, node, model, stamp } = site;
  const entry = node.block!;
  const array = node.inputs[1]!;

  const length = loadCount(editor, node, array, ARRAY_LENGTH_OFFSET, model, stamp);
  const none = constantAt(editor, node, EMPTY_LENGTH, stamp);
  const step = constantAt(editor, node, STEP, stamp);
  const drained = stamp(irInt32Compare(EQUALS, length, none));
  editor.insertBefore(node, drained);

  const take = splitBlockBefore(graph, entry, node);
  const empty = faultingBlock(site, take, EMPTY_POP);
  append(entry, irBranch(drained, empty, take), stamp);
  link(entry, empty);
  link(entry, take);

  const last = stamp(irInt32Sub(length, step));
  last.props.noOverflow = true;
  editor.insertBefore(node, last);
  const buffer = loadBuffer(editor, node, array, model, stamp);
  const value = describedLoad(site, node, buffer, last);
  storeCount(editor, node, array, ARRAY_LENGTH_OFFSET, last, model, stamp);

  replaceWith(site, value, []);
  return true;
}

function lowerReverse(site: Site): boolean {
  if (argumentsOf(site.node).length !== NO_ARGUMENTS) return false;
  const { editor, node, stamp } = site;
  const array = node.inputs[1]!;

  let last!: CFGInstruction;
  const scan = openScan(site, (length) => {
    const step = constantAt(editor, node, STEP, stamp);
    last = stamp(irInt32Sub(length, step));
    last.props.noOverflow = true;
    editor.insertBefore(node, last);
    const half = stamp(irInt32Shr(length, step));
    editor.insertBefore(node, half);
    return half;
  });

  const anchor = append(scan.body, irJump(scan.advance), stamp);
  link(scan.body, scan.advance);
  const mirror = stamp(irInt32Sub(last, scan.cursor));
  mirror.props.noOverflow = true;
  editor.insertBefore(anchor, mirror);
  const front = describedLoad(site, anchor, scan.buffer, scan.cursor);
  const back = describedLoad(site, anchor, scan.buffer, mirror);
  elementAccess(editor, anchor, irStoreElement(scan.buffer, scan.cursor, back), site.model, stamp);
  elementAccess(editor, anchor, irStoreElement(scan.buffer, mirror, front), site.model, stamp);
  append(scan.exhausted, irJump(scan.after), stamp);
  connect(scan.exhausted, scan.after);

  replaceWith(site, array, []);
  return true;
}

function elementLattice(scalar: AotScalar): LatticeType {
  if (scalar === SCALAR_INT32) return smiType();
  if (scalar === SCALAR_FLOAT64) return doubleType();
  return stringType();
}

function textConstantAt(site: Site, value: string): CFGInstruction {
  const constant = site.stamp(irConstant(value));
  site.editor.insertBefore(site.node, constant);
  return constant;
}

function elementText(
  site: Site,
  block: CFGBlock,
  element: CFGInstruction,
): CFGInstruction {
  if (site.model.element === SCALAR_STRING) return element;
  const intrinsic = builtinMethodIntrinsicFor(
    elementLattice(site.model.element),
    TO_STRING_MEMBER,
  )!;
  const text = append(
    block,
    irCallBuiltin(intrinsic.qualifiedName, [element], builtinMethodCallMetadata(intrinsic)),
    site.stamp,
  );
  text.frameState = site.node.frameState;
  return text;
}

function lowerJoin(site: Site): boolean {
  const args = argumentsOf(site.node);
  if (args.length > ONE_ARGUMENT) return false;
  if (site.model.element === SCALAR_POINTER) return false;

  if (
    site.model.element !== SCALAR_STRING &&
    builtinMethodIntrinsicFor(elementLattice(site.model.element), TO_STRING_MEMBER) === null
  ) {
    return false;
  }

  const { graph, stamp } = site;
  const blank = textConstantAt(site, EMPTY_TEXT);
  const separator = args[0] ?? textConstantAt(site, DEFAULT_SEPARATOR);

  const scan = openScan(site);
  const carried = stamp(addPhi(scan.header, [blank]));

  const first = append(scan.body, irInt32Compare(EQUALS, scan.cursor, scan.origin), stamp);
  const leading = graph.addBlock();
  const between = graph.addBlock();
  const merge = graph.addBlock();
  append(scan.body, irBranch(first, leading, between), stamp);
  link(scan.body, leading);
  link(scan.body, between);
  append(leading, irJump(merge), stamp);
  append(between, irJump(merge), stamp);

  const spacing = stamp(addPhi(merge));
  connect(leading, merge, [blank]);
  connect(between, merge, [separator]);

  const element = appendLoad(site, merge, scan.buffer, scan.cursor);
  const piece = elementText(site, merge, element);
  const spaced = append(merge, irGenericAdd(carried, spacing), stamp);
  const grown = append(merge, irGenericAdd(spaced, piece), stamp);
  append(merge, irJump(scan.advance), stamp);
  link(merge, scan.advance);
  carried.addInput(grown);

  append(scan.exhausted, irJump(scan.after), stamp);
  connect(scan.exhausted, scan.after);

  replaceWith(site, carried, []);
  return true;
}

function lowerSort(site: Site): boolean {
  if (argumentsOf(site.node).length !== ONE_ARGUMENT) return false;
  const callback = callbackAt(site, 0);
  if (callback === null) return false;
  if (callback.signature.params.length !== ORDERED_PAIR) return false;
  const ordering = aotScalarOf(
    nominalLatticeType(callback.signature.returns, site.graph.classes),
  );
  if (ordering !== SCALAR_INT32 && ordering !== SCALAR_FLOAT64) return false;

  const { graph, editor, node, model, stamp } = site;
  const entry = node.block!;
  const array = node.inputs[1]!;

  const length = loadCount(editor, node, array, ARRAY_LENGTH_OFFSET, model, stamp);
  const buffer = loadBuffer(editor, node, array, model, stamp);
  const step = constantAt(editor, node, STEP, stamp);
  const origin = constantAt(editor, node, FIRST_INDEX, stamp);

  const after = splitBlockBefore(graph, entry, node);
  const outer = graph.addBlock();
  const pick = graph.addBlock();
  const inner = graph.addBlock();
  const probe = graph.addBlock();
  const shift = graph.addBlock();
  const place = graph.addBlock();
  const sorted = graph.addBlock();

  append(entry, irJump(outer), stamp);
  link(entry, outer);

  const cursor = stamp(addPhi(outer, [step]));
  const remaining = append(outer, irInt32Compare(LESS_THAN, cursor, length), stamp);
  append(outer, irBranch(remaining, pick, sorted), stamp);
  link(outer, pick);
  link(outer, sorted);

  const carried = appendLoad(site, pick, buffer, cursor);
  const start = offsetBy(site, pick, cursor, step, false);
  append(pick, irJump(inner), stamp);
  link(pick, inner);

  const slot = stamp(addPhi(inner, [start]));
  const above = append(inner, irInt32Compare(AT_LEAST, slot, origin), stamp);
  append(inner, irBranch(above, probe, place), stamp);
  link(inner, probe);
  link(inner, place);

  const settled = appendLoad(site, probe, buffer, slot);
  const order = invoke(site, probe, callback, [settled, carried]);
  const zero = append(probe, irConstant(FIRST_INDEX), stamp);
  const later = append(
    probe,
    ordering === SCALAR_INT32
      ? irInt32Compare(GREATER_THAN, order, zero)
      : irFloat64Compare(GREATER_THAN, order, zero),
    stamp,
  );
  append(probe, irBranch(later, shift, place), stamp);
  link(probe, shift);
  link(probe, place);

  appendStore(site, shift, buffer, offsetBy(site, shift, slot, step, true), settled);
  const previous = offsetBy(site, shift, slot, step, false);
  append(shift, irJump(inner), stamp);
  link(shift, inner);
  slot.addInput(previous);

  appendStore(site, place, buffer, offsetBy(site, place, slot, step, true), carried);
  const advanced = offsetBy(site, place, cursor, step, true);
  append(place, irJump(outer), stamp);
  link(place, outer);
  cursor.addInput(advanced);

  append(sorted, irJump(after), stamp);
  link(sorted, after);

  replaceWith(site, array, [callback.source]);
  return true;
}

function collectedInto(
  site: Site,
  scan: Scan,
  block: CFGBlock,
  result: CFGInstruction,
  value: CFGInstruction,
  model: ArrayModel,
): void {
  const jump = append(block, irJump(scan.advance), site.stamp);
  pushElement(site.editor, jump, result, value, model, site.stamp);
  link(block, scan.advance);
}

function lowerMap(site: Site): boolean {
  if (argumentsOf(site.node).length !== ONE_ARGUMENT) return false;
  const callback = callbackAt(site, 0);
  if (callback === null || callback.signature.returns === null) return false;
  const arity = callback.signature.params.length;
  if (arity < ELEMENT_ONLY || arity > ELEMENT_AND_INDEX) return false;
  const classes = site.graph.classes!;
  const mapped = arrayModelForElement(
    classes,
    nominalLatticeType(callback.signature.returns, classes),
  );
  if (mapped === null) return false;

  const result = emptyArray(site.editor, site.node, mapped, site.stamp);
  const scan = openScan(site);
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  const value = invoke(
    site,
    scan.body,
    callback,
    suppliedArguments(callback, [element, scan.cursor], ELEMENT_ONLY)!,
  );
  collectedInto(site, scan, scan.body, result, value, mapped);
  append(scan.exhausted, irJump(scan.after), site.stamp);
  connect(scan.exhausted, scan.after);

  replaceWith(site, result, [callback.source]);
  return true;
}

function lowerFilter(site: Site): boolean {
  if (argumentsOf(site.node).length !== ONE_ARGUMENT) return false;
  const callback = callbackAt(site, 0);
  if (callback === null) return false;
  const arity = callback.signature.params.length;
  if (arity < ELEMENT_ONLY || arity > ELEMENT_AND_INDEX) return false;

  const result = emptyArray(site.editor, site.node, site.model, site.stamp);
  const scan = openScan(site);
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  const keep = invoke(
    site,
    scan.body,
    callback,
    suppliedArguments(callback, [element, scan.cursor], ELEMENT_ONLY)!,
  );
  const kept = site.graph.addBlock();
  append(scan.body, irBranch(keep, kept, scan.advance), site.stamp);
  link(scan.body, kept);
  link(scan.body, scan.advance);
  collectedInto(site, scan, kept, result, element, site.model);
  append(scan.exhausted, irJump(scan.after), site.stamp);
  connect(scan.exhausted, scan.after);

  replaceWith(site, result, [callback.source]);
  return true;
}

const LOWERINGS: ReadonlyMap<string, Lowering> = new Map<string, Lowering>([
  ["index_of", (site) => lowerSearch(site, { asBoolean: false })],
  ["includes", (site) => lowerSearch(site, { asBoolean: true })],
  ["find_index", (site) => lowerPredicate(site, { stopsWhenTrue: true, comparison: null })],
  ["some", (site) => lowerPredicate(site, { stopsWhenTrue: true, comparison: GREATER_THAN })],
  ["every", (site) => lowerPredicate(site, { stopsWhenTrue: false, comparison: EQUALS })],
  ["map", lowerMap],
  ["pop", lowerPop],
  ["reverse", lowerReverse],
  ["sort", lowerSort],
  ["join", lowerJoin],
  ["filter", lowerFilter],
  ["for_each", lowerForEach],
  ["reduce", lowerReduce],
]);

function loweringFor(node: CFGInstruction): { callee: CFGInstruction; lower: Lowering } | null {
  for (const [member, lower] of LOWERINGS) {
    const callee = memberCalled(node, member);
    if (callee !== null) return { callee, lower };
  }
  return null;
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
      const lowering = loweringFor(node);
      if (lowering === null) continue;
      const model = arrayModelOf(node.inputs[1], graph, classes, types);
      if (model === null) continue;
      if (!lowering.lower({ graph, editor, node, callee: lowering.callee, model, stamp })) continue;
      changed++;
      break;
    }
  }
  if (changed > 0) graph.rebuildUses();
  return changed;
}
