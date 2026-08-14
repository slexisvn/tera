import * as ir from "../ir/index.js";
import { link } from "../ir/cfg-edit.js";
import {
  rememberIncomingState,
  type IncomingStatesByTarget,
  type RegisterState,
} from "./cfg-state.js";
import { TERA_CONTEXT } from "../target/runtime-layout.js";
import { SCALAR_INT32, SCALAR_STRING, type AotScalar } from "../types/scalar.js";

const FIELD_TYPE_PROP = "fieldType";
const FIELD_SCALAR_PROP = "fieldScalar";
const PENDING_FLAG_TYPE = "int";
const NOT_PENDING = 0;
const PENDING = 1;

export const PENDING_THROW_TYPE = "string";

const PENDING_FLAG_OFFSET = TERA_CONTEXT.offsetOf("pendingThrowFlag");
const PENDING_VALUE_OFFSET = TERA_CONTEXT.offsetOf("pendingThrowValue");

export const PENDING_THROW_PROP = "pendingThrow";
export const PENDING_THROW_STATUS = 0;

const RAISE_PROP = "raisesPendingThrow";
const FORWARD_PROP = "forwardsPendingThrow";
const TAKE_PROP = "takesPendingThrow";

type Graph = ir.CFGFunction;
type Block = ir.CFGBlock;
type Node = ir.CFGInstruction;

const PENDING_FIELDS = new Map<number, { declared: string; scalar: AotScalar }>([
  [PENDING_FLAG_OFFSET, { declared: PENDING_FLAG_TYPE, scalar: SCALAR_INT32 }],
  [PENDING_VALUE_OFFSET, { declared: PENDING_THROW_TYPE, scalar: SCALAR_STRING }],
]);

function typedField(node: Node, offset: number): Node {
  const field = PENDING_FIELDS.get(offset)!;
  node.props[FIELD_TYPE_PROP] = field.declared;
  node.props[FIELD_SCALAR_PROP] = field.scalar;
  return node;
}

function constantIn(block: Block, value: number): Node {
  const node = ir.irConstant(value);
  block.addNode(node);
  return node;
}

function contextBase(block: Block): Node {
  const base = ir.irRuntimeBase(TERA_CONTEXT.symbol);
  block.addNode(base);
  return base;
}

function loadPending(block: Block, base: Node, offset: number): Node {
  const load = typedField(ir.irLoadField(base, offset), offset);
  block.addNode(load);
  return load;
}

function storePending(block: Block, base: Node, offset: number, value: Node): Node {
  const store = typedField(ir.irStoreField(base, offset, value, `pending.${offset}`), offset);
  block.addNode(store);
  return store;
}

export function recordPendingThrow(block: Block, thrown: Node): void {
  const base = contextBase(block);
  storePending(block, base, PENDING_VALUE_OFFSET, thrown).props[FORWARD_PROP] = true;
  storePending(block, base, PENDING_FLAG_OFFSET, constantIn(block, PENDING)).props[
    RAISE_PROP
  ] = true;
}

export function raisesPendingThrow(node: { props: Record<string, unknown> }): boolean {
  return node.props[RAISE_PROP] === true;
}

export function forwardsPendingThrow(node: { props: Record<string, unknown> }): boolean {
  return node.props[FORWARD_PROP] === true;
}

export function takePendingThrow(block: Block): Node {
  const base = contextBase(block);
  const thrown = loadPending(block, base, PENDING_VALUE_OFFSET);
  thrown.props[TAKE_PROP] = true;
  storePending(block, base, PENDING_FLAG_OFFSET, constantIn(block, NOT_PENDING));
  return thrown;
}

export function takesPendingThrow(node: { props: Record<string, unknown> }): boolean {
  return node.props[TAKE_PROP] === true;
}

export function returnPendingThrow(block: Block): void {
  const node = ir.irReturn(constantIn(block, PENDING_THROW_STATUS));
  node.props[PENDING_THROW_PROP] = true;
  block.addNode(node);
}

export function isPendingThrowReturn(node: { props: Record<string, unknown> }): boolean {
  return node.props[PENDING_THROW_PROP] === true;
}

export function clearPendingThrowReturn(node: { props: Record<string, unknown> }): void {
  delete node.props[PENDING_THROW_PROP];
}

export interface PendingThrowBranch {
  readonly taken: Block;
  readonly resumed: Block;
}

export function branchOnPendingThrow(graph: Graph, block: Block): PendingThrowBranch {
  const base = contextBase(block);
  const flag = loadPending(block, base, PENDING_FLAG_OFFSET);
  const pending = ir.irInt32Compare("!=", flag, constantIn(block, NOT_PENDING));
  block.addNode(pending);

  const taken = graph.addBlock();
  const resumed = graph.addBlock();
  block.addNode(ir.irBranch(pending, taken, resumed));
  link(block, taken);
  link(block, resumed);
  return { taken, resumed };
}

export interface PendingThrowLanding {
  readonly handler: Block;
  readonly target: number;
}

interface HandlerEdge {
  readonly at: number;
  readonly stack: readonly number[];
}

interface BytecodeLike {
  readonly opcode: number;
  readonly operands: readonly number[];
}

interface HandlerOpcodes {
  readonly tryStart: number;
  readonly tryEnd: number;
  readonly jump: number;
  readonly jumpIfTrue: number;
  readonly jumpIfFalse: number;
  readonly returns: number;
  readonly throws: number;
}

export function handlerStacksOf(
  instructions: readonly BytecodeLike[],
  opcodes: HandlerOpcodes,
): ReadonlyArray<readonly number[]> {
  const stacks: Array<readonly number[] | undefined> = new Array(instructions.length);
  const pending: HandlerEdge[] = [{ at: 0, stack: [] }];
  while (pending.length > 0) {
    const { at, stack } = pending.pop()!;
    if (at >= instructions.length || stacks[at] !== undefined) continue;
    stacks[at] = stack;
    const { opcode, operands } = instructions[at]!;
    if (opcode === opcodes.returns || opcode === opcodes.throws) continue;
    if (opcode === opcodes.tryStart) {
      pending.push({ at: operands[0]!, stack });
      pending.push({ at: at + 1, stack: [...stack, operands[0]!] });
      continue;
    }
    if (opcode === opcodes.tryEnd) {
      pending.push({ at: at + 1, stack: stack.slice(0, -1) });
      continue;
    }
    if (opcode === opcodes.jump) {
      pending.push({ at: operands[0]!, stack });
      continue;
    }
    if (opcode === opcodes.jumpIfTrue || opcode === opcodes.jumpIfFalse) {
      pending.push({ at: operands[0]!, stack });
    }
    pending.push({ at: at + 1, stack });
  }
  return stacks.map((stack) => stack ?? []);
}

export function recoverAfterCall(
  graph: Graph,
  block: Block,
  landing: PendingThrowLanding | null,
  regs: RegisterState,
  savedBlockRegs: IncomingStatesByTarget,
): Block {
  const { taken, resumed } = branchOnPendingThrow(graph, block);
  if (landing === null) {
    returnPendingThrow(taken);
    return resumed;
  }
  const thrown = takePendingThrow(taken);
  rememberIncomingState(savedBlockRegs, landing.target, taken, regs, thrown);
  taken.addNode(ir.irJump(landing.handler));
  link(taken, landing.handler);
  return resumed;
}
