import {
  CFGInstruction as IRNode,
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_LOAD_GLOBAL,
  IR_SPREAD_ELEMENTS,
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
  memberCalled,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  type IRMetadataValue,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { compiledFunctionConstant } from "../ir/compiled-function.js";
import { functionTargetOf } from "../metadata/module-functions.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import type { TypeInference } from "../analyses/type-inference.js";
import type { DeclaredSignature } from "../types/signature.js";
import { nominalLatticeType } from "../types/declared.js";
import {
  arrayModelForElement,
  arrayModelForShape,
  arrayModelOf,
  elementAccess,
  emptyArray,
  pushElement,
  storeCount,
  describeElement,
  loadBuffer,
  loadCount,
  type ArrayModel,
} from "./array-shapes.js";
import { append, constantAt, faultWhen, type Stamp } from "./guards.js";
import { ARRAY_LENGTH_OFFSET } from "../metadata/class-table.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicFor,
  TO_STRING_MEMBER,
} from "../metadata/builtin-methods.js";
import { doubleType, smiType, stringType, type LatticeType } from "../types/lattice.js";
import {
  aotScalarOf,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_TEXT,
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
const EMPTY_SHIFT = "cannot shift an empty array";
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

function argumentsOf(node: CFGInstruction): CFGInstruction[] {
  return node.inputs.slice(CALLEE_AND_RECEIVER);
}

function calledFunctionName(source: CFGInstruction): string | null {
  const stamped = functionTargetOf(source);
  if (stamped !== null) return stamped;
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

type Bound = (length: CFGInstruction) => CFGInstruction;

function openScan(site: Site, boundOf: Bound | null = null, originOf: Bound | null = null): Scan {
  const { graph, editor, node, model, stamp } = site;
  const array = node.inputs[1]!;

  const counted = loadCount(editor, node, array, ARRAY_LENGTH_OFFSET, model, stamp);
  const length = boundOf === null ? counted : boundOf(counted);
  const buffer = loadBuffer(editor, node, array, model, stamp);
  const start =
    originOf === null ? constantAt(editor, node, FIRST_INDEX, stamp) : originOf(counted);
  const step = constantAt(editor, node, STEP, stamp);
  const missing = constantAt(editor, node, NOT_FOUND, stamp);

  const entry = node.block!;
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
  site.editor.removeIfDead(site.callee);
  for (const source of sources) site.editor.removeIfDead(source);
}

function replaceWith(
  site: Site,
  result: CFGInstruction,
  sources: readonly CFGInstruction[],
): void {
  site.editor.replaceAllUses(site.node, result);
  retire(site, sources);
}

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

function lowerFind(site: Site): boolean {
  if (argumentsOf(site.node).length !== ONE_ARGUMENT) return false;
  const callback = callbackAt(site, 0);
  if (callback === null) return false;
  const arity = callback.signature.params.length;
  if (arity < ELEMENT_ONLY || arity > ELEMENT_AND_INDEX) return false;

  const scan = openScan(site);
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  const args = suppliedArguments(callback, [element, scan.cursor], ELEMENT_ONLY)!;
  const test = invoke(site, scan.body, callback, args);
  const stop = stopOn(site, scan, test, true);

  const absent = append(scan.exhausted, irConstant(null), site.stamp);
  append(scan.exhausted, irJump(scan.after), site.stamp);
  const found = site.stamp(addPhi(scan.after));
  connect(stop, scan.after, [element]);
  connect(scan.exhausted, scan.after, [absent]);

  replaceWith(site, found, [callback.source]);
  return true;
}

function lowerFlat(site: Site): boolean {
  if (argumentsOf(site.node).length !== NO_ARGUMENTS) return false;
  const classes = site.graph.classes;
  if (classes === null) return false;
  const inner = arrayModelForShape(classes, site.model.elementShape);
  if (inner === null) return false;

  const { graph, editor, node, stamp } = site;
  const flattened = emptyArray(editor, node, inner, stamp);
  const scan = openScan(site);
  const nested = appendLoad(site, scan.body, scan.buffer, scan.cursor);

  const header = graph.addBlock();
  const body = graph.addBlock();
  const opening = append(scan.body, irJump(header), stamp);
  const length = loadCount(editor, opening, nested, ARRAY_LENGTH_OFFSET, inner, stamp);
  const buffer = loadBuffer(editor, opening, nested, inner, stamp);
  const origin = constantAt(editor, opening, FIRST_INDEX, stamp);
  const step = constantAt(editor, opening, STEP, stamp);
  link(scan.body, header);

  const cursor = stamp(addPhi(header, [origin]));
  const more = append(header, irInt32Compare(LESS_THAN, cursor, length), stamp);
  append(header, irBranch(more, body, scan.advance), stamp);
  link(header, body);
  link(header, scan.advance);

  const closing = append(body, irJump(header), stamp);
  const value = elementAccess(editor, closing, irLoadElement(buffer, cursor), inner, stamp);
  pushElement(editor, closing, flattened, value, inner, stamp);
  const next = stamp(irInt32Add(cursor, step));
  next.props.noOverflow = true;
  editor.insertBefore(closing, next);
  link(body, header);
  cursor.addInput(next);

  append(scan.exhausted, irJump(scan.after), stamp);
  connect(scan.exhausted, scan.after);

  replaceWith(site, flattened, []);
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

function faultWhenEmpty(site: Site, message: string): CFGInstruction {
  const { graph, editor, node, model, stamp } = site;
  const array = node.inputs[1]!;
  const length = loadCount(editor, node, array, ARRAY_LENGTH_OFFSET, model, stamp);
  const none = constantAt(editor, node, EMPTY_LENGTH, stamp);
  const drained = stamp(irInt32Compare(EQUALS, length, none));
  editor.insertBefore(node, drained);
  faultWhen(graph, node, drained, message, stamp);
  return length;
}

function shortenedBy(site: Site, length: CFGInstruction, step: CFGInstruction): CFGInstruction {
  const shorter = site.stamp(irInt32Sub(length, step));
  shorter.props.noOverflow = true;
  site.editor.insertBefore(site.node, shorter);
  return shorter;
}

function lowerShift(site: Site): boolean {
  if (argumentsOf(site.node).length !== NO_ARGUMENTS) return false;
  const { editor, node, model, stamp } = site;
  const array = node.inputs[1]!;

  const length = faultWhenEmpty(site, EMPTY_SHIFT);
  const step = constantAt(editor, node, STEP, stamp);
  const front = constantAt(editor, node, FIRST_INDEX, stamp);
  const held = describedLoad(site, node, loadBuffer(editor, node, array, model, stamp), front);
  const taken = detachedText(site, held, (added) => editor.insertBefore(node, added));
  const shorter = shortenedBy(site, length, step);

  const scan = openScan(site, () => shorter);
  const following = offsetBy(site, scan.body, scan.cursor, step, true);
  const moved = appendLoad(site, scan.body, scan.buffer, following);
  appendStore(site, scan.body, scan.buffer, scan.cursor, moved);
  append(scan.body, irJump(scan.advance), stamp);
  link(scan.body, scan.advance);
  append(scan.exhausted, irJump(scan.after), stamp);
  connect(scan.exhausted, scan.after);

  storeCount(editor, node, array, ARRAY_LENGTH_OFFSET, shorter, model, stamp);
  replaceWith(site, taken, []);
  return true;
}

function lowerPop(site: Site): boolean {
  if (argumentsOf(site.node).length !== NO_ARGUMENTS) return false;
  const { editor, node, model, stamp } = site;
  const array = node.inputs[1]!;

  const length = faultWhenEmpty(site, EMPTY_POP);
  const step = constantAt(editor, node, STEP, stamp);

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
  const front = detachedText(site, describedLoad(site, anchor, scan.buffer, scan.cursor), (added) =>
    editor.insertBefore(anchor, added),
  );
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

function answersText(scalar: AotScalar): boolean {
  return scalar === SCALAR_STRING || scalar === SCALAR_TEXT;
}

function detachedText(
  site: Site,
  value: CFGInstruction,
  emit: (node: CFGInstruction) => void,
): CFGInstruction {
  if (site.model.element !== SCALAR_TEXT) return value;
  const blank = site.stamp(irConstant(EMPTY_TEXT));
  emit(blank);
  const copy = site.stamp(irGenericAdd(value, blank));
  copy.frameState = site.node.frameState;
  emit(copy);
  return copy;
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
  if (answersText(site.model.element)) return element;
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
    !answersText(site.model.element) &&
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

function spellsElements(site: Site): boolean {
  if (site.model.element === SCALAR_POINTER) return false;
  if (answersText(site.model.element)) return true;
  return builtinMethodIntrinsicFor(elementLattice(site.model.element), TO_STRING_MEMBER) !== null;
}

function comparingCallback(site: Site): SortOrdering | null {
  const callback = callbackAt(site, 0);
  if (callback === null || callback.signature.params.length !== ORDERED_PAIR) return null;
  const ordering = aotScalarOf(
    nominalLatticeType(callback.signature.returns, site.graph.classes),
  );
  if (ordering !== SCALAR_INT32 && ordering !== SCALAR_FLOAT64) return null;
  return { callback, ordering };
}

type SortOrdering = {
  readonly callback: Callback;
  readonly ordering: AotScalar;
};

function comesLater(
  site: Site,
  block: CFGBlock,
  ordering: SortOrdering | null,
  settled: CFGInstruction,
  carried: CFGInstruction,
): CFGInstruction {
  if (ordering === null) {
    const first = elementText(site, block, settled);
    const second = elementText(site, block, carried);
    return append(block, irGenericCompare(GREATER_THAN, first, second), site.stamp);
  }
  const order = invoke(site, block, ordering.callback, [settled, carried]);
  const zero = append(block, irConstant(FIRST_INDEX), site.stamp);
  return append(
    block,
    ordering.ordering === SCALAR_INT32
      ? irInt32Compare(GREATER_THAN, order, zero)
      : irFloat64Compare(GREATER_THAN, order, zero),
    site.stamp,
  );
}

function lowerSort(site: Site): boolean {
  const args = argumentsOf(site.node);
  if (args.length > ONE_ARGUMENT) return false;
  const ordering = args.length === ONE_ARGUMENT ? comparingCallback(site) : null;
  if (args.length === ONE_ARGUMENT && ordering === null) return false;
  if (ordering === null && !spellsElements(site)) return false;

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

  const loaded = appendLoad(site, pick, buffer, cursor);
  const start = offsetBy(site, pick, cursor, step, false);
  const carried = detachedText(site, loaded, (added) => {
    append(pick, added, stamp);
  });
  append(pick, irJump(inner), stamp);
  link(pick, inner);

  const slot = stamp(addPhi(inner, [start]));
  const above = append(inner, irInt32Compare(AT_LEAST, slot, origin), stamp);
  append(inner, irBranch(above, probe, place), stamp);
  link(inner, probe);
  link(inner, place);

  const settled = appendLoad(site, probe, buffer, slot);
  const later = comesLater(site, probe, ordering, settled, carried);
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

  replaceWith(site, array, ordering === null ? [] : [ordering.callback.source]);
  return true;
}

function chooseAt(
  site: Site,
  test: CFGInstruction,
  whenTrue: CFGInstruction,
  whenFalse: CFGInstruction,
): CFGInstruction {
  const { graph, node, stamp } = site;
  const entry = node.block!;
  const after = splitBlockBefore(graph, entry, node);
  const chosen = stamp(addPhi(after));
  const [otherwise, taken] = [whenFalse, whenTrue].map((value) => {
    const arm = graph.addBlock();
    append(arm, irJump(after), stamp);
    connect(arm, after, [value]);
    return arm;
  });
  append(entry, irBranch(test, taken!, otherwise!), stamp);
  link(entry, taken!);
  link(entry, otherwise!);
  return chosen;
}

function comparedAt(
  site: Site,
  operator: string,
  left: CFGInstruction,
  right: CFGInstruction,
): CFGInstruction {
  const test = site.stamp(irInt32Compare(operator, left, right));
  site.editor.insertBefore(site.node, test);
  return test;
}

function summedAt(site: Site, left: CFGInstruction, right: CFGInstruction): CFGInstruction {
  const sum = site.stamp(irInt32Add(left, right));
  sum.props.noOverflow = true;
  site.editor.insertBefore(site.node, sum);
  return sum;
}

function sliceBound(
  site: Site,
  index: CFGInstruction,
  length: CFGInstruction,
  clamp: (bound: CFGInstruction) => CFGInstruction,
): CFGInstruction {
  const origin = constantAt(site.editor, site.node, FIRST_INDEX, site.stamp);
  const behind = comparedAt(site, LESS_THAN, index, origin);
  return clamp(chooseAt(site, behind, summedAt(site, index, length), index));
}

function lowerSlice(site: Site): boolean {
  const args = argumentsOf(site.node);
  if (args.length > ORDERED_PAIR) return false;
  const [from, until] = args;

  const result = emptyArray(site.editor, site.node, site.model, site.stamp);
  const scan = openScan(
    site,
    (length) =>
      until === undefined
        ? length
        : sliceBound(site, until, length, (bound) =>
            chooseAt(site, comparedAt(site, GREATER_THAN, bound, length), length, bound),
          ),
    (length) =>
      from === undefined
        ? constantAt(site.editor, site.node, FIRST_INDEX, site.stamp)
        : sliceBound(site, from, length, (bound) => {
            const origin = constantAt(site.editor, site.node, FIRST_INDEX, site.stamp);
            return chooseAt(site, comparedAt(site, LESS_THAN, bound, origin), origin, bound);
          }),
  );

  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  collectedInto(site, scan, scan.body, result, element, site.model);
  append(scan.exhausted, irJump(scan.after), site.stamp);
  connect(scan.exhausted, scan.after);

  replaceWith(site, result, []);
  return true;
}

function lowerLastSearch(site: Site): boolean {
  const wanted = argumentsOf(site.node);
  if (wanted.length !== ONE_ARGUMENT) return false;

  const scan = openScan(site);
  const carried = site.stamp(addPhi(scan.header, [scan.missing]));
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  const same = append(scan.body, comparison(site.model.element, element, wanted[0]!), site.stamp);
  const hit = site.graph.addBlock();
  append(scan.body, irBranch(same, hit, scan.advance), site.stamp);
  link(scan.body, hit);
  link(scan.body, scan.advance);
  append(hit, irJump(scan.advance), site.stamp);

  const latest = site.stamp(addPhi(scan.advance));
  connect(scan.body, scan.advance, [carried]);
  connect(hit, scan.advance, [scan.cursor]);
  carried.addInput(latest);

  append(scan.exhausted, irJump(scan.after), site.stamp);
  connect(scan.exhausted, scan.after);

  replaceWith(site, carried, []);
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
  ["last_index_of", lowerLastSearch],
  ["includes", (site) => lowerSearch(site, { asBoolean: true })],
  ["slice", lowerSlice],
  ["find_index", (site) => lowerPredicate(site, { stopsWhenTrue: true, comparison: null })],
  ["find", lowerFind],
  ["flat", lowerFlat],
  ["some", (site) => lowerPredicate(site, { stopsWhenTrue: true, comparison: GREATER_THAN })],
  ["every", (site) => lowerPredicate(site, { stopsWhenTrue: false, comparison: EQUALS })],
  ["map", lowerMap],
  ["pop", lowerPop],
  ["shift", lowerShift],
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

function lowerSpread(site: Site, target: CFGInstruction, into: ArrayModel): boolean {
  const scan = openScan(site);
  const element = appendLoad(site, scan.body, scan.buffer, scan.cursor);
  collectedInto(site, scan, scan.body, target, element, into);
  append(scan.exhausted, irJump(scan.after), site.stamp);
  connect(scan.exhausted, scan.after);
  site.editor.remove(site.node);
  return true;
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
      const model = arrayModelOf(node.inputs[1], graph, classes, types);
      if (model === null) continue;
      if (node.type === IR_SPREAD_ELEMENTS) {
        const target = node.inputs[0]!;
        const into = arrayModelOf(target, graph, classes, types);
        if (into === null) continue;
        lowerSpread({ graph, editor, node, callee: node, model, stamp }, target, into);
        changed++;
        break;
      }
      const lowering = loweringFor(node);
      if (lowering === null) continue;
      if (!lowering.lower({ graph, editor, node, callee: lowering.callee, model, stamp })) continue;
      changed++;
      break;
    }
  }
  if (changed > 0) graph.rebuildUses();
  return changed;
}
