import {
  irBranch,
  irCallBuiltin,
  irCallKnownFunction,
  irGenericCall,
  irConstant,
  irGenericAdd,
  irInt32Add,
  irInt32Compare,
  irInt32Sub,
  irJump,
  irLoadField,
  irLoadText,
  irNewArray,
  irNewObject,
  irReturn,
  irRuntimeBase,
  irStoreField,
  irStoreText,
  withIRNodeIdAllocator,
  CFGFunction,
  IRNodeIdAllocator,
  IR_AWAIT,
  IR_CONSTANT,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_LOAD_ELEMENT,
  IR_NEW_ARRAY,
  IR_PHI,
  IR_STORE_ELEMENT,
  IR_RETURN,
  IR_RUNTIME_BASE,
  SETTLED_TYPE_PROP,
  type CFGBlock,
  type CFGInstruction,
} from "../ir/index.js";
import { disconnect, link } from "../ir/cfg-edit.js";
import { maxNodeId } from "../ir/graph-edit.js";
import { computeValueLiveness } from "../analyses/value-liveness.js";
import { inferTypes } from "../analyses/type-inference.js";
import {
  isPendingThrowReturn,
  recordPendingThrow,
  takePendingThrow,
} from "../builder/throw-recovery.js";
import { TERA_CONTEXT, type TeraContextField } from "../target/runtime-layout.js";
import {
  TERA_NEVER_SETTLED,
  TERA_REJECTED_PREFIX,
  TERA_REJECTED_SEPARATOR,
} from "../target/faults.js";
import {
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  THROW_BUILTIN,
} from "../metadata/builtin-methods.js";
import {
  declaredAotScalar,
  CLASS_ID_PROP,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  INSTANCE_SIZE_PROP,
  VALUE_CLASS_PROP,
  type ClassShape,
  type ClassTable,
} from "../metadata/class-table.js";
import {
  coroutineFrameShape,
  coroutineResumeName,
  coroutineParameterName,
  coroutineSlotName,
  CORO_ENTRY_STATE,
  CORO_ERROR_FIELD,
  CORO_FRAME_BASE,
  CORO_NEXT_FIELD,
  CORO_NEXT_REJECTED_FIELD,
  CORO_NOBODY_WAITING,
  CORO_PROMISE_BASE,
  CORO_REPORTED,
  CORO_RESULT_FIELD,
  CORO_ROUTINE_FIELD,
  CORO_SOMEONE_WAITING,
  CORO_STATE_FIELD,
  CORO_STATE_PENDING,
  CORO_STATE_REJECTED,
  CORO_STATE_RESOLVED,
  CORO_UNREPORTED,
  CORO_UNREPORTED_FIELD,
  CORO_VALUE_FIELD,
  CORO_WAITER_FIELD,
  CORO_WAITING_FIELD,
  coroutineCarriesValue,
  type CoroutineSlot,
} from "../metadata/coroutines.js";
import {
  aotScalarOf,
  scalarWidth,
  SCALAR_CODE,
  SCALAR_POINTER,
  SCALAR_TEXT,
  VALUE_SCALAR_PROP,
} from "../types/scalar.js";
import { CODE_TARGET_PROP } from "../analyses/aot-legality.js";
import { nominalLatticeType } from "../types/declared.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";

export const CORO_DRAIN = "tera_drain";
export const CORO_REPORT = "tera_report_rejections";

const RESUME_PENDING = 1;
const RESUME_DONE = 0;
const INT = "int";

const ARRAY_WRITES = new Set<string>([IR_STORE_ELEMENT, IR_GENERIC_SET_INDEX]);
const ARRAY_READS = new Set<string>([IR_LOAD_ELEMENT, IR_GENERIC_GET_INDEX]);

const SLOT_TYPES = new Map<string, string>([
  [TypeKind.Smi, INT],
  [TypeKind.Boolean, "bool"],
  [TypeKind.Double, "float"],
  [TypeKind.Number, "float"],
  [TypeKind.String, "string"],
]);

export class CoroutineSplitError extends Error {}

function typed(node: CFGInstruction, declaredType: string, classes: ClassTable): CFGInstruction {
  node.props[FIELD_TYPE_PROP] = declaredType;
  node.props[FIELD_SCALAR_PROP] =
    declaredAotScalar(declaredType, classes) ??
    aotScalarOf(nominalLatticeType(declaredType, classes)) ??
    SCALAR_POINTER;
  return node;
}

function fieldOf(shape: ClassShape, name: string) {
  const field = shape.fields.get(name);
  if (field === undefined) throw new CoroutineSplitError(`${shape.name} has no field ${name}`);
  return field;
}

export class Emitter {
  private cursor: number;

  constructor(
    private readonly classes: ClassTable,
    private readonly block: CFGBlock,
    insertAt: number | null = null,
  ) {
    this.cursor = insertAt ?? -1;
  }

  add<T extends CFGInstruction>(node: T): T {
    if (this.cursor < 0) {
      this.block.addNode(node);
      return node;
    }
    node.block = this.block;
    this.block.nodes.splice(this.cursor++, 0, node);
    return node;
  }

  position(): number {
    return this.cursor < 0 ? this.block.nodes.length : this.cursor;
  }

  constant(value: number): CFGInstruction {
    return this.add(irConstant(value));
  }

  code(symbol: string): CFGInstruction {
    const node = irConstant(0);
    node.props[CODE_TARGET_PROP] = symbol;
    node.props[VALUE_SCALAR_PROP] = SCALAR_CODE;
    return this.add(node);
  }

  load(object: CFGInstruction, shape: ClassShape, name: string): CFGInstruction {
    const field = fieldOf(shape, name);
    if (field.scalar === SCALAR_TEXT) {
      return this.add(irLoadText(object, field.offset, scalarWidth(SCALAR_TEXT), name));
    }
    return this.add(
      typed(irLoadField(object, field.offset), field.declaredType, this.classes),
    );
  }

  store(
    object: CFGInstruction,
    shape: ClassShape,
    name: string,
    value: CFGInstruction,
  ): CFGInstruction {
    const field = fieldOf(shape, name);
    if (field.scalar === SCALAR_TEXT) {
      return this.add(irStoreText(object, field.offset, value, scalarWidth(SCALAR_TEXT), name));
    }
    return this.add(
      typed(
        irStoreField(object, field.offset, value, name),
        field.declaredType,
        this.classes,
      ),
    );
  }

  context(): CFGInstruction {
    return this.add(irRuntimeBase(TERA_CONTEXT.symbol));
  }

  loadContext(base: CFGInstruction, name: TeraContextField, declared: string): CFGInstruction {
    return this.add(
      typed(irLoadField(base, TERA_CONTEXT.offsetOf(name)), declared, this.classes),
    );
  }

  storeContext(
    base: CFGInstruction,
    name: TeraContextField,
    declared: string,
    value: CFGInstruction,
  ): void {
    this.add(
      typed(
        irStoreField(base, TERA_CONTEXT.offsetOf(name), value, name),
        declared,
        this.classes,
      ),
    );
  }

  allocate(shape: ClassShape): CFGInstruction {
    const node = irNewObject();
    node.props[CLASS_ID_PROP] = shape.id;
    node.props[INSTANCE_SIZE_PROP] = shape.size;
    node.props[VALUE_CLASS_PROP] = shape.id;
    this.add(node);
    for (const field of shape.fields.values()) {
      if (field.scalar === SCALAR_POINTER) this.store(node, shape, field.name, node);
    }
    return node;
  }
}

function detach(node: CFGInstruction): void {
  for (const input of node.inputs) input.uses = input.uses.filter((use) => use !== node);
  node.inputs = [];
  node.uses = [];
}

export function unlink(node: CFGInstruction): void {
  const block = node.block;
  if (block !== null) {
    const at = block.nodes.indexOf(node);
    if (at >= 0) block.nodes.splice(at, 1);
    if (block.terminator === node) block.terminator = null;
  }
  detach(node);
  node.block = null;
}

function deliverSettled(
  graph: CFGFunction,
  out: Emitter,
  node: CFGInstruction,
  awaited: CFGInstruction,
  promise: ClassShape,
): void {
  if (!coroutineCarriesValue(promise)) {
    if (node.uses.length === 0) return;
    throw new CoroutineSplitError(
      `${graph.name} uses the result of an await on a function that returns nothing; ` +
        `give that function a return type, or keep this part interpreted`,
    );
  }
  replaceUses(node, out.load(awaited, promise, CORO_VALUE_FIELD));
}

function replaceUses(value: CFGInstruction, replacement: CFGInstruction): void {
  for (const use of [...value.uses]) {
    for (let index = 0; index < use.inputs.length; index++) {
      if (use.inputs[index] === value) use.replaceInput(index, replacement);
    }
  }
}

export function withFreshNodeIds<T>(graph: CFGFunction, rewrite: () => T): T {
  return withIRNodeIdAllocator(new IRNodeIdAllocator(maxNodeId(graph) + 1), rewrite);
}

export function returnsOf(graph: CFGFunction): readonly CFGInstruction[] {
  const found: CFGInstruction[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_RETURN) found.push(node);
    }
  }
  return found;
}

export interface CoroutineSplit {
  readonly resume: CFGFunction | null;
  readonly promise: ClassShape;
  readonly frame: ClassShape | null;
}

export type PromiseOf = (node: CFGInstruction) => ClassShape | null;

export interface ResumePoint {
  readonly resume: CFGBlock;
}

interface SuspendPoint extends ResumePoint {
  readonly state: number;
  readonly block: CFGBlock;
  readonly awaited: CFGInstruction;
  readonly promise: ClassShape | null;
}

export function severAfter(graph: CFGFunction, block: CFGBlock, at: number): CFGBlock {
  const tail = graph.addBlock();
  for (const node of block.nodes.splice(at + 1)) {
    node.block = tail;
    tail.nodes.push(node);
  }
  tail.terminator = block.terminator;
  tail.successors = block.successors;
  block.successors = [];
  block.terminator = null;
  for (const successor of tail.successors) {
    successor.predecessors[successor.predecessors.indexOf(block)] = tail;
  }
  block.addNode(irJump(tail));
  link(block, tail);
  return tail;
}

function isPromiseShape(shape: ClassShape | null): boolean {
  return shape !== null && shape.parent === CORO_PROMISE_BASE;
}

interface RaiseBranch {
  readonly raise: CFGBlock;
  readonly resumed: CFGBlock;
}

function branchWhen(
  graph: CFGFunction,
  block: CFGBlock,
  condition: CFGInstruction,
): RaiseBranch {
  const resumed = severAfter(graph, block, block.nodes.indexOf(condition));
  unlink(block.getTerminator()!);
  disconnect(block, resumed);
  const raise = graph.addBlock();
  block.addNode(irBranch(condition, raise, resumed));
  link(block, raise);
  link(block, resumed);
  return { raise, resumed };
}

function stateIs(
  classes: ClassTable,
  out: Emitter,
  awaited: CFGInstruction,
  promise: ClassShape,
  state: number,
): CFGInstruction {
  const settled = out.load(awaited, promise, CORO_STATE_FIELD);
  return out.add(irInt32Compare("==", settled, out.constant(state)));
}

function raiseWhenRejected(
  graph: CFGFunction,
  classes: ClassTable,
  block: CFGBlock,
  at: number,
  awaited: CFGInstruction,
  promise: ClassShape,
): CFGBlock {
  if (!graph.recoversThrows) return block;
  const out = new Emitter(classes, block, at);
  const rejected = stateIs(classes, out, awaited, promise, CORO_STATE_REJECTED);
  const { raise, resumed } = branchWhen(graph, block, rejected);

  const raised = new Emitter(classes, raise);
  raised.store(awaited, promise, CORO_UNREPORTED_FIELD, raised.constant(CORO_REPORTED));
  recordPendingThrow(raise, raised.load(awaited, promise, CORO_ERROR_FIELD));
  raise.addNode(irJump(resumed));
  link(raise, resumed);
  return resumed;
}

function stopWhenPending(
  graph: CFGFunction,
  classes: ClassTable,
  block: CFGBlock,
  at: number,
  awaited: CFGInstruction,
  promise: ClassShape,
): CFGBlock {
  const out = new Emitter(classes, block, at);
  const pending = stateIs(classes, out, awaited, promise, CORO_STATE_PENDING);
  const { raise, resumed } = branchWhen(graph, block, pending);

  const stopped = new Emitter(classes, raise);
  const intrinsic = builtinGlobalIntrinsicByName(THROW_BUILTIN)!;
  raise.addNode(
    irCallBuiltin(
      THROW_BUILTIN,
      [stopped.add(irConstant(TERA_NEVER_SETTLED))],
      builtinMethodCallMetadata(intrinsic),
    ),
  );
  raise.addNode(irJump(resumed));
  link(raise, resumed);
  return resumed;
}

function suspendPointsOf(
  graph: CFGFunction,
  classes: ClassTable,
  promiseOf: PromiseOf,
): readonly SuspendPoint[] {
  const types = inferTypes(graph);
  const shapeOfValue = (value: CFGInstruction): ClassShape | null => {
    const type = types.typeOf(value);
    if (type.kind !== TypeKind.Object || typeof type.map !== "number") return null;
    return classes.shapeById(type.map);
  };

  const points: SuspendPoint[] = [];
  for (let index = 0; index < graph.blocks.length; index++) {
    const block = graph.blocks[index]!;
    const at = block.nodes.findIndex((node) => node.type === IR_AWAIT);
    if (at < 0) continue;
    const suspend = block.nodes[at]!;
    const awaited = suspend.inputs[0]!;
    const promise = promiseOf(awaited);
    if (promise === null && isPromiseShape(shapeOfValue(awaited))) {
      throw new CoroutineSplitError(
        `${graph.name} awaits a promise the compiler cannot trace back to the function that ` +
          `settles it; await the call directly, or keep this part interpreted`,
      );
    }
    const resume = severAfter(graph, block, at);
    if (promise === null) {
      replaceUses(suspend, awaited);
      unlink(suspend);
    } else {
      const out = new Emitter(classes, resume, 0);
      deliverSettled(graph, out, suspend, awaited, promise);
      unlink(suspend);
      raiseWhenRejected(graph, classes, resume, out.position(), awaited, promise);
    }
    points.push({ state: points.length + 1, block, resume, awaited, promise });
  }
  return points;
}

function localizeInto(
  graph: CFGFunction,
  selects: (node: CFGInstruction) => boolean,
  rematerialize: (node: CFGInstruction) => CFGInstruction,
): void {
  const prepended = new Map<CFGBlock, CFGInstruction[]>();
  for (const block of [...graph.blocks]) {
    for (const node of [...block.nodes]) {
      if (!selects(node)) continue;
      const copies = new Map<CFGBlock, CFGInstruction>([[block, node]]);
      for (const use of [...node.uses]) {
        const owner = use.block;
        if (owner === null || use.type === IR_PHI) continue;
        let copy = copies.get(owner);
        if (copy === undefined) {
          copy = rematerialize(node);
          copy.block = owner;
          const pending = prepended.get(owner);
          if (pending === undefined) prepended.set(owner, [copy]);
          else pending.push(copy);
          copies.set(owner, copy);
        }
        for (let index = 0; index < use.inputs.length; index++) {
          if (use.inputs[index] === node) use.replaceInput(index, copy);
        }
      }
    }
  }
  for (const [block, copies] of prepended) block.nodes.unshift(...copies);
  graph.rebuildUses();
}

export function localizeRuntimeBases(graph: CFGFunction): void {
  localizeInto(
    graph,
    (node) => node.type === IR_RUNTIME_BASE,
    (node) => irRuntimeBase(String(node.props.symbol)),
  );
}

function rematerializable(node: CFGInstruction): boolean {
  if (node.type !== IR_NEW_ARRAY) return false;
  if (!node.inputs.every((input) => input.type === IR_CONSTANT)) return false;
  return !node.uses.some((use) => ARRAY_WRITES.has(use.type) && use.inputs[0] === node);
}

export function localizeConstantArrays(graph: CFGFunction): void {
  localizeInto(graph, rematerializable, (node) => {
    const copy = irNewArray(node.inputs);
    copy.props = { ...node.props };
    return copy;
  });
}

function slotTypeOf(type: LatticeType, classes: ClassTable): string | null {
  if (type.kind === TypeKind.Object) {
    return typeof type.map === "number" ? classes.shapeById(type.map)?.name ?? null : null;
  }
  return SLOT_TYPES.get(type.kind) ?? null;
}

function loadedElementType(value: CFGInstruction): string | null {
  if (!ARRAY_READS.has(value.type)) return null;
  const array = value.inputs[0];
  if (array === undefined || array.type !== IR_NEW_ARRAY) return null;
  const text = array.inputs.every(
    (input) => input.type === IR_CONSTANT && typeof input.props.value === "string",
  );
  return text ? SLOT_TYPES.get(TypeKind.String) ?? null : null;
}

export class FrameSpills {
  private readonly names = new Map<CFGInstruction, string>();
  private readonly reloads = new Map<string, CFGInstruction>();
  readonly slots: CoroutineSlot[] = [];
  private shape: ClassShape | null = null;
  private self: CFGInstruction | null = null;

  constructor(
    graph: CFGFunction,
    private readonly classes: ClassTable,
    points: readonly ResumePoint[],
  ) {
    const types = inferTypes(graph);
    const declare = (value: CFGInstruction, name: string): void => {
      const type = types.typeOf(value);
      const declaredType = slotTypeOf(type, classes) ?? loadedElementType(value);
      if (declaredType === null) {
        throw new CoroutineSplitError(
          `${graph.name} keeps a ${type.kind} value across a suspend, and the compiler has no ` +
            `frame slot for that type; annotate it, or keep this part interpreted`,
        );
      }
      this.names.set(value, name);
      this.slots.push({ name, declaredType });
    };

    graph.parameters.forEach((parameter, index) => {
      declare(parameter, coroutineParameterName(index));
    });
    const liveness = computeValueLiveness(graph);
    const carried = new Set<CFGInstruction>();
    for (const point of points) {
      for (const value of liveness.liveIn(point.resume)) carried.add(value);
    }
    let spilled = 0;
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (!carried.has(node) || node.type === IR_CONSTANT || this.names.has(node)) continue;
        declare(node, coroutineSlotName(spilled++));
      }
    }
  }

  spillInto(shape: ClassShape, self: CFGInstruction): void {
    this.shape = shape;
    this.self = self;
    for (const [value, name] of this.names) {
      if (value.block === null) continue;
      const out = new Emitter(this.classes, value.block, this.definitionEnd(value));
      out.store(self, shape, name, value);
    }
    for (const [value] of this.names) this.reloadUses(value);
  }

  private definitionEnd(value: CFGInstruction): number {
    const block = value.block!;
    return value.type === IR_PHI ? block.phis.length : block.nodes.indexOf(value) + 1;
  }

  private reloadUses(value: CFGInstruction): void {
    for (const use of [...value.uses]) {
      const owner = use.block;
      if (owner === null) continue;
      for (let index = 0; index < use.inputs.length; index++) {
        if (use.inputs[index] !== value) continue;
        const where = use.type === IR_PHI ? owner.predecessors[index]! : owner;
        const available = this.valueAt(value, where);
        if (available !== value) use.replaceInput(index, available);
      }
    }
  }

  private valueAt(value: CFGInstruction, block: CFGBlock): CFGInstruction {
    if (value.block === block) return value;
    const name = this.names.get(value);
    if (name === undefined) return value;
    const key = `${name}@${block.id}`;
    const cached = this.reloads.get(key);
    if (cached !== undefined) return cached;
    const out = new Emitter(this.classes, block, block.phis.length);
    const reload = out.load(this.self!, this.shape!, name);
    this.reloads.set(key, reload);
    return reload;
  }
}

function enqueue(
  resume: CFGFunction,
  classes: ClassTable,
  frame: CFGInstruction,
  base: ClassShape,
  from: CFGBlock,
): CFGBlock {
  const opening = new Emitter(classes, from);
  opening.store(frame, base, CORO_NEXT_FIELD, frame);
  const count = opening.loadContext(opening.context(), "queueCount", INT);
  const empty = opening.add(irInt32Compare("==", count, opening.constant(0)));

  const first = resume.addBlock();
  const appended = resume.addBlock();
  const join = resume.addBlock();
  from.addNode(irBranch(empty, first, appended));
  link(from, first);
  link(from, appended);

  const head = new Emitter(classes, first);
  head.storeContext(head.context(), "queueHead", CORO_FRAME_BASE, frame);
  first.addNode(irJump(join));
  link(first, join);

  const chain = new Emitter(classes, appended);
  const tail = chain.loadContext(chain.context(), "queueTail", CORO_FRAME_BASE);
  chain.store(tail, base, CORO_NEXT_FIELD, frame);
  appended.addNode(irJump(join));
  link(appended, join);

  const settle = new Emitter(classes, join);
  const context = settle.context();
  settle.storeContext(context, "queueTail", CORO_FRAME_BASE, frame);
  const held = settle.loadContext(context, "queueCount", INT);
  settle.storeContext(context, "queueCount", INT, settle.add(irInt32Add(held, settle.constant(1))));
  return join;
}

function suspendAt(
  resume: CFGFunction,
  classes: ClassTable,
  frame: ClassShape,
  self: CFGInstruction,
  point: SuspendPoint,
): void {
  unlink(point.block.getTerminator()!);
  disconnect(point.block, point.resume);
  const out = new Emitter(classes, point.block);
  out.store(self, frame, CORO_STATE_FIELD, out.constant(point.state));
  if (point.promise === null) {
    const queued = enqueue(resume, classes, self, frame, point.block);
    queued.addNode(irReturn(new Emitter(classes, queued).constant(RESUME_PENDING)));
    return;
  }

  const settled = out.load(point.awaited, point.promise, CORO_STATE_FIELD);
  const ready = out.add(irInt32Compare("!=", settled, out.constant(CORO_STATE_PENDING)));
  const wakeable = resume.addBlock();
  const parking = resume.addBlock();
  const pending = resume.addBlock();
  point.block.addNode(irBranch(ready, wakeable, parking));
  link(point.block, wakeable);
  link(point.block, parking);

  const queued = enqueue(resume, classes, self, frame, wakeable);
  queued.addNode(irJump(pending));
  link(queued, pending);

  const park = new Emitter(classes, parking);
  park.store(point.awaited, point.promise, CORO_WAITER_FIELD, self);
  park.store(
    point.awaited,
    point.promise,
    CORO_WAITING_FIELD,
    park.constant(CORO_SOMEONE_WAITING),
  );
  parking.addNode(irJump(pending));
  link(parking, pending);

  pending.addNode(irReturn(new Emitter(classes, pending).constant(RESUME_PENDING)));
}

interface Settlement {
  readonly field: string;
  readonly state: number;
  settled(block: CFGBlock, returned: CFGInstruction | null): CFGInstruction | null;
  track(out: Emitter, held: CFGInstruction, promise: ClassShape): void;
}

const RESOLVES: Settlement = {
  field: CORO_VALUE_FIELD,
  state: CORO_STATE_RESOLVED,
  settled: (_block, returned) => returned,
  track: () => undefined,
};

const REJECTS: Settlement = {
  field: CORO_ERROR_FIELD,
  state: CORO_STATE_REJECTED,
  settled: (block) => takePendingThrow(block),
  track: (out, held, promise) => {
    const context = out.context();
    out.store(
      held,
      promise,
      CORO_NEXT_REJECTED_FIELD,
      out.loadContext(context, "rejectedHead", CORO_PROMISE_BASE),
    );
    const outstanding = out.loadContext(context, "rejectedCount", INT);
    out.storeContext(context, "rejectedHead", CORO_PROMISE_BASE, held);
    out.storeContext(
      context,
      "rejectedCount",
      INT,
      out.add(irInt32Add(outstanding, out.constant(1))),
    );
  },
};

function settlementOf(exit: CFGInstruction): Settlement {
  return isPendingThrowReturn(exit) ? REJECTS : RESOLVES;
}

function settleAt(
  resume: CFGFunction,
  classes: ClassTable,
  frame: ClassShape,
  promise: ClassShape,
  self: CFGInstruction,
  exit: CFGInstruction,
): void {
  const block = exit.block!;
  const returned = exit.inputs[0] ?? null;
  const settlement = settlementOf(exit);
  unlink(exit);
  const settled = settlement.settled(block, returned);
  const out = new Emitter(classes, block);
  const held = out.load(self, frame, CORO_RESULT_FIELD);
  if (settled !== null && promise.fields.has(settlement.field)) {
      out.store(held, promise, settlement.field, settled);
    }
  out.store(held, promise, CORO_STATE_FIELD, out.constant(settlement.state));
  settlement.track(out, held, promise);

  const waiting = out.load(held, promise, CORO_WAITING_FIELD);
  const wakes = out.add(irInt32Compare("==", waiting, out.constant(CORO_SOMEONE_WAITING)));
  const waking = resume.addBlock();
  const done = resume.addBlock();
  block.addNode(irBranch(wakes, waking, done));
  link(block, waking);
  link(block, done);

  const wake = new Emitter(classes, waking);
  const waiter = wake.load(held, promise, CORO_WAITER_FIELD);
  wake.store(held, promise, CORO_WAITING_FIELD, wake.constant(CORO_NOBODY_WAITING));
  const queued = enqueue(resume, classes, waiter, classes.shapeOf(CORO_FRAME_BASE)!, waking);
  queued.addNode(irJump(done));
  link(queued, done);

  done.addNode(irReturn(new Emitter(classes, done).constant(RESUME_DONE)));
}

export function dispatchStates(
  resume: CFGFunction,
  classes: ClassTable,
  frame: ClassShape,
  self: CFGInstruction,
  targets: readonly CFGBlock[],
): CFGBlock {
  const head = resume.addBlock();
  const out = new Emitter(classes, head);
  const state = out.load(self, frame, CORO_STATE_FIELD);
  let block = head;
  for (let index = 0; index < targets.length - 1; index++) {
    const test = new Emitter(classes, block);
    const matches = test.add(irInt32Compare("==", state, test.constant(index)));
    const next = resume.addBlock();
    block.addNode(irBranch(matches, targets[index]!, next));
    link(block, targets[index]!);
    link(block, next);
    block = next;
  }
  const last = targets[targets.length - 1]!;
  block.addNode(irJump(last));
  link(block, last);
  return head;
}

function settleInPlace(
  graph: CFGFunction,
  classes: ClassTable,
  promise: ClassShape,
): CoroutineSplit {
  const entry = graph.entry!;
  const opening = new Emitter(classes, entry, entry.phis.length);
  const held = opening.allocate(promise);
  opening.store(held, promise, CORO_STATE_FIELD, opening.constant(CORO_STATE_RESOLVED));
  opening.store(held, promise, CORO_WAITING_FIELD, opening.constant(CORO_NOBODY_WAITING));
  opening.store(held, promise, CORO_UNREPORTED_FIELD, opening.constant(CORO_UNREPORTED));
  for (const exit of returnsOf(graph)) {
    const block = exit.block!;
    const returned = exit.inputs[0] ?? null;
    const settlement = settlementOf(exit);
    unlink(exit);
    const settled = settlement.settled(block, returned);
    const out = new Emitter(classes, block);
    if (settled !== null && promise.fields.has(settlement.field)) {
      out.store(held, promise, settlement.field, settled);
    }
    out.store(held, promise, CORO_STATE_FIELD, out.constant(settlement.state));
    settlement.track(out, held, promise);
    block.addNode(irReturn(held));
  }
  graph.declaredSignature = {
    params: graph.declaredSignature?.params ?? [],
    returns: promise.name,
  };
  graph.rebuildUses();
  return { resume: null, promise, frame: null };
}

export function splitCoroutine(
  graph: CFGFunction,
  classes: ClassTable,
  promise: ClassShape,
  promiseOf: PromiseOf,
): CoroutineSplit {
  return withFreshNodeIds(graph, () => splitInPlace(graph, classes, promise, promiseOf));
}

function splitInPlace(
  graph: CFGFunction,
  classes: ClassTable,
  promise: ClassShape,
  promiseOf: PromiseOf,
): CoroutineSplit {
  const points = suspendPointsOf(graph, classes, promiseOf);
  if (points.length === 0) return settleInPlace(graph, classes, promise);
  const awaited = new Set(
    points.flatMap((point) => (point.promise === null ? [] : [point.promise.name])),
  );
  if (graph.recoversThrows && awaited.size > 1) {
    throw new CoroutineSplitError(
      `${graph.name} can catch a throw from awaits on ${awaited.size} different functions, ` +
        `and the compiler cannot yet tell those rejections apart; await one of them at a ` +
        `time, or keep this part interpreted`,
    );
  }

  localizeRuntimeBases(graph);
  localizeConstantArrays(graph);
  const spills = new FrameSpills(graph, classes, points);
  const frame = coroutineFrameShape(classes, graph.name, spills.slots);
  const parameters = [...graph.parameters];
  const body = graph.entry!;

  const resume = new CFGFunction(coroutineResumeName(graph.name));
  resume.classes = classes;
  resume.internal = true;
  resume.resumable = true;
  resume.declaredSignature = { params: [frame.name], returns: INT };
  const self = resume.addParameter(0);
  resume.takeBlocks([...graph.blocks], body);

  const exits = returnsOf(resume);
  for (const point of points) suspendAt(resume, classes, frame, self, point);
  spills.spillInto(frame, self);
  for (const exit of exits) settleAt(resume, classes, frame, promise, self, exit);
  const head = dispatchStates(resume, classes, frame, self, [
    body,
    ...points.map((point) => point.resume),
  ]);
  resume.takeBlocks([head, ...resume.blocks.filter((block) => block !== head)], head);
  resume.rebuildUses();

  graph.blocks = [];
  graph.entry = null;
  const opening = new Emitter(classes, graph.addBlock());
  const held = opening.allocate(promise);
  const created = opening.allocate(frame);
  opening.store(created, frame, CORO_RESULT_FIELD, held);
  opening.store(created, frame, CORO_ROUTINE_FIELD, opening.code(resume.name));
  opening.store(created, frame, CORO_STATE_FIELD, opening.constant(CORO_ENTRY_STATE));
  opening.store(held, promise, CORO_STATE_FIELD, opening.constant(CORO_STATE_PENDING));
  opening.store(held, promise, CORO_WAITING_FIELD, opening.constant(CORO_NOBODY_WAITING));
  opening.store(held, promise, CORO_UNREPORTED_FIELD, opening.constant(CORO_UNREPORTED));
  parameters.forEach((parameter, index) => {
    opening.store(created, frame, coroutineParameterName(index), parameter);
  });
  opening.add(irCallKnownFunction({ name: resume.name } as never, [created]));
  opening.add(irReturn(held));
  graph.declaredSignature = { params: graph.declaredSignature?.params ?? [], returns: promise.name };
  graph.rebuildUses();

  return { resume, promise, frame };
}

export function drainBeforeExit(graph: CFGFunction): number {
  return withFreshNodeIds(graph, () => {
    let inserted = 0;
    for (const block of graph.blocks) {
      const at = block.nodes.findIndex((node) => node.type === IR_RETURN);
      if (at < 0) continue;
      const calls = [CORO_DRAIN, CORO_REPORT].map((name) => {
        const call = irCallKnownFunction({ name } as never, []);
        call.block = block;
        return call;
      });
      block.nodes.splice(at, 0, ...calls);
      inserted++;
    }
    if (inserted > 0) graph.rebuildUses();
    return inserted;
  });
}

export function buildReportRejections(classes: ClassTable): CFGFunction {
  const graph = new CFGFunction(CORO_REPORT);
  graph.classes = classes;
  graph.internal = true;
  graph.declaredSignature = { params: [], returns: INT };
  graph.parameterCount = 0;
  const base = classes.shapeOf(CORO_PROMISE_BASE)!;

  const entry = graph.addBlock();
  const test = graph.addBlock();
  const body = graph.addBlock();
  const collect = graph.addBlock();
  const first = graph.addBlock();
  const append = graph.addBlock();
  const finish = graph.addBlock();
  const report = graph.addBlock();
  const done = graph.addBlock();

  entry.addNode(irJump(test));
  link(entry, test);

  const guard = new Emitter(classes, test);
  const outstanding = guard.loadContext(guard.context(), "rejectedCount", INT);
  const remaining = guard.add(irInt32Compare(">", outstanding, guard.constant(0)));
  test.addNode(irBranch(remaining, body, finish));
  link(test, body);
  link(test, finish);

  const step = new Emitter(classes, body);
  const context = step.context();
  const head = step.loadContext(context, "rejectedHead", CORO_PROMISE_BASE);
  step.storeContext(
    context,
    "rejectedHead",
    CORO_PROMISE_BASE,
    step.load(head, base, CORO_NEXT_REJECTED_FIELD),
  );
  step.storeContext(context, "rejectedCount", INT, step.add(irInt32Sub(outstanding, step.constant(1))));
  const unreported = step.load(head, base, CORO_UNREPORTED_FIELD);
  const escaped = step.add(irInt32Compare("==", unreported, step.constant(CORO_UNREPORTED)));
  body.addNode(irBranch(escaped, collect, test));
  link(body, collect);
  link(body, test);

  const gather = new Emitter(classes, collect);
  const reported = gather.loadContext(gather.context(), "reportedCount", INT);
  const already = gather.add(irInt32Compare(">", reported, gather.constant(0)));
  collect.addNode(irBranch(already, append, first));
  link(collect, append);
  link(collect, first);

  const opening = new Emitter(classes, first);
  const started = opening.context();
  opening.storeContext(started, "reportedCount", INT, opening.constant(1));
  opening.storeContext(started, "rejectedText", CORO_PROMISE_BASE, head);
  first.addNode(irJump(test));
  link(first, test);

  const joined = new Emitter(classes, append);
  const carried = joined.context();
  const earlier = joined.load(
    joined.loadContext(carried, "rejectedText", CORO_PROMISE_BASE),
    base,
    CORO_ERROR_FIELD,
  );
  const separated = joined.add(
    irGenericAdd(
      joined.load(head, base, CORO_ERROR_FIELD),
      joined.add(irConstant(TERA_REJECTED_SEPARATOR)),
    ),
  );
  joined.store(head, base, CORO_ERROR_FIELD, joined.add(irGenericAdd(separated, earlier)));
  joined.storeContext(carried, "rejectedText", CORO_PROMISE_BASE, head);
  append.addNode(irJump(test));
  link(append, test);

  const ending = new Emitter(classes, finish);
  const total = ending.loadContext(ending.context(), "reportedCount", INT);
  const escapes = ending.add(irInt32Compare(">", total, ending.constant(0)));
  finish.addNode(irBranch(escapes, report, done));
  link(finish, report);
  link(finish, done);

  const raise = new Emitter(classes, report);
  const intrinsic = builtinGlobalIntrinsicByName(THROW_BUILTIN)!;
  const escaping = raise.add(
    irGenericAdd(
      raise.add(irConstant(TERA_REJECTED_PREFIX)),
      raise.load(
        raise.loadContext(raise.context(), "rejectedText", CORO_PROMISE_BASE),
        base,
        CORO_ERROR_FIELD,
      ),
    ),
  );
  report.addNode(
    irCallBuiltin(THROW_BUILTIN, [escaping], builtinMethodCallMetadata(intrinsic)),
  );
  report.addNode(irJump(done));
  link(report, done);

  const exit = new Emitter(classes, done);
  done.addNode(irReturn(exit.constant(RESUME_DONE)));
  graph.rebuildUses();
  return graph;
}

export function buildDrain(classes: ClassTable): CFGFunction {
  const graph = new CFGFunction(CORO_DRAIN);
  graph.classes = classes;
  graph.internal = true;
  graph.declaredSignature = { params: [], returns: INT };
  graph.parameterCount = 0;
  const base = classes.shapeOf(CORO_FRAME_BASE)!;

  const entry = graph.addBlock();
  const test = graph.addBlock();
  const body = graph.addBlock();
  const done = graph.addBlock();

  entry.addNode(irJump(test));
  link(entry, test);

  const guard = new Emitter(classes, test);
  const context = guard.context();
  const count = guard.loadContext(context, "queueCount", INT);
  const pending = guard.add(irInt32Compare(">", count, guard.constant(0)));
  test.addNode(irBranch(pending, body, done));
  link(test, body);
  link(test, done);

  const step = new Emitter(classes, body);
  const inner = step.context();
  const head = step.loadContext(inner, "queueHead", CORO_FRAME_BASE);
  const next = step.load(head, base, CORO_NEXT_FIELD);
  step.storeContext(inner, "queueHead", CORO_FRAME_BASE, next);
  const remaining = step.loadContext(inner, "queueCount", INT);
  step.storeContext(
    inner,
    "queueCount",
    INT,
    step.add(irInt32Sub(remaining, step.constant(1))),
  );
  const routine = step.load(head, base, CORO_ROUTINE_FIELD);
  const resumed = irGenericCall(routine, [head]);
  body.addNode(resumed);
  body.addNode(irJump(test));
  link(body, test);

  const exit = new Emitter(classes, done);
  done.addNode(irReturn(exit.constant(RESUME_DONE)));
  graph.rebuildUses();
  return graph;
}

export type SettledTypeOf = (node: CFGInstruction) => string | null;

export function typeAwaitedResults(graph: CFGFunction, settledTypeOf: SettledTypeOf): number {
  let typed = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_AWAIT) continue;
      const settled = settledTypeOf(node.inputs[0]!);
      if (settled === null || node.props[SETTLED_TYPE_PROP] === settled) continue;
      node.props[SETTLED_TYPE_PROP] = settled;
      typed++;
    }
  }
  return typed;
}

export function lowerAwaitedPromises(
  graph: CFGFunction,
  classes: ClassTable,
  promiseOf: (node: CFGInstruction) => ClassShape | null,
): number {
  return withFreshNodeIds(graph, () => {
    let lowered = 0;
    for (const block of graph.blocks) {
      for (;;) {
        const at = block.nodes.findIndex(
          (node) => node.type === IR_AWAIT && promiseOf(node.inputs[0]!) !== null,
        );
        if (at < 0) break;
        const node = block.nodes[at]!;
        const awaited = node.inputs[0]!;
        const shape = promiseOf(awaited)!;
        const out = new Emitter(classes, block, at);
        out.add(irCallKnownFunction({ name: CORO_DRAIN } as never, []));
        deliverSettled(graph, out, node, awaited, shape);
        unlink(node);
        const settledHere = stopWhenPending(graph, classes, block, out.position(), awaited, shape);
        raiseWhenRejected(graph, classes, settledHere, 0, awaited, shape);
        lowered++;
      }
    }
    if (lowered > 0) graph.rebuildUses();
    return lowered;
  });
}
