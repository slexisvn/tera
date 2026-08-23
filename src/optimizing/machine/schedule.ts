import {
  registerOperandsOf,
  type MachineBlock,
  type MachineFunction,
  type MachineInstruction,
} from "./ir.js";
import type { MachineLowering } from "./lowering.js";

export interface InstructionEffect {
  readonly readsFlags?: boolean;
  readonly writesFlags?: boolean;
  readonly barrier?: boolean;
  readonly latency?: number;
}

export const UNMODELLED_EFFECT: InstructionEffect = {
  readsFlags: true,
  writesFlags: true,
  barrier: true,
};

const DEFAULT_LATENCY = 1;

const FLAGS = { resource: "flags" };
const MEMORY = { resource: "memory" };
const ORDER = { resource: "order" };

type Resource = object;

interface Slot {
  readonly successors: Set<number>;
  waiting: number;
  height: number;
}

class ReadyQueue {
  private readonly items: number[] = [];

  constructor(private readonly precedes: (left: number, right: number) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  push(value: number): void {
    this.items.push(value);
    for (let at = this.items.length - 1; at > 0; ) {
      const parent = (at - 1) >> 1;
      if (!this.precedes(this.items[at]!, this.items[parent]!)) return;
      this.swap(at, parent);
      at = parent;
    }
  }

  pop(): number {
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length === 0) return top;
    this.items[0] = last;
    for (let at = 0; ; ) {
      const left = at * 2 + 1;
      const right = left + 1;
      let best = at;
      if (left < this.items.length && this.precedes(this.items[left]!, this.items[best]!)) {
        best = left;
      }
      if (right < this.items.length && this.precedes(this.items[right]!, this.items[best]!)) {
        best = right;
      }
      if (best === at) return top;
      this.swap(at, best);
      at = best;
    }
  }

  private swap(left: number, right: number): void {
    const held = this.items[left]!;
    this.items[left] = this.items[right]!;
    this.items[right] = held;
  }
}

function touchesMemory(node: MachineInstruction): boolean {
  return node.operands.some((operand) => operand.kind === "memory");
}

function readResourcesOf(node: MachineInstruction, effect: InstructionEffect): Resource[] {
  const reads: Resource[] = [ORDER];
  for (const operand of registerOperandsOf(node)) {
    if (operand.role === "use") reads.push(operand.register);
  }
  if (effect.readsFlags === true) reads.push(FLAGS);
  if (touchesMemory(node)) reads.push(MEMORY);
  return reads;
}

function writeResourcesOf(node: MachineInstruction, effect: InstructionEffect): Resource[] {
  const writes: Resource[] = [];
  for (const operand of registerOperandsOf(node)) {
    if (operand.role === "def") writes.push(operand.register);
  }
  if (effect.writesFlags === true) writes.push(FLAGS);
  if (touchesMemory(node)) writes.push(MEMORY);
  if (effect.barrier === true || node.flags.call === true) writes.push(ORDER);
  return writes;
}

function branches(node: MachineInstruction): boolean {
  return node.operands.some((operand) => operand.kind === "label");
}

function bounds(node: MachineInstruction | undefined): boolean {
  if (node === undefined) return true;
  if (node.flags.terminator === true || node.flags.prologue === true) return true;
  return branches(node);
}

function regionsOf(block: MachineBlock): Array<readonly [number, number]> {
  const instructions = block.instructions;
  const regions: Array<readonly [number, number]> = [];
  let start = 0;
  for (let at = 0; at <= instructions.length; at++) {
    if (!bounds(instructions[at])) continue;
    let end = at;
    while (end > start && instructions[end - 1]!.flags.copy === true) end--;
    if (end - start >= 2) regions.push([start, end]);
    start = at + 1;
  }
  return regions;
}

function scheduleRegion(
  block: MachineBlock,
  lowering: MachineLowering,
  start: number,
  end: number,
): boolean {
  const span = end - start;

  const effects: InstructionEffect[] = [];
  const slots: Slot[] = [];
  for (let at = 0; at < span; at++) {
    effects.push(lowering.effectOf(block.instructions[start + at]!));
    slots.push({ successors: new Set<number>(), waiting: 0, height: 0 });
  }

  const lastWrite = new Map<Resource, number>();
  const sinceWrite = new Map<Resource, number[]>();
  const depend = (from: number, to: number): void => {
    if (from === to || slots[from]!.successors.has(to)) return;
    slots[from]!.successors.add(to);
    slots[to]!.waiting++;
  };

  for (let at = 0; at < span; at++) {
    const node = block.instructions[start + at]!;
    const effect = effects[at]!;
    for (const resource of readResourcesOf(node, effect)) {
      const written = lastWrite.get(resource);
      if (written !== undefined) depend(written, at);
      const readers = sinceWrite.get(resource);
      if (readers === undefined) sinceWrite.set(resource, [at]);
      else readers.push(at);
    }
    for (const resource of writeResourcesOf(node, effect)) {
      const written = lastWrite.get(resource);
      if (written !== undefined) depend(written, at);
      for (const reader of sinceWrite.get(resource) ?? []) depend(reader, at);
      lastWrite.set(resource, at);
      sinceWrite.set(resource, []);
    }
  }

  for (let at = span - 1; at >= 0; at--) {
    const slot = slots[at]!;
    let below = 0;
    for (const successor of slot.successors) below = Math.max(below, slots[successor]!.height);
    slot.height = below + (effects[at]!.latency ?? DEFAULT_LATENCY);
  }

  const ready = new ReadyQueue(
    (left, right) =>
      slots[left]!.height !== slots[right]!.height
        ? slots[left]!.height > slots[right]!.height
        : left < right,
  );
  for (let at = 0; at < span; at++) {
    if (slots[at]!.waiting === 0) ready.push(at);
  }

  const order: number[] = [];
  while (ready.size > 0) {
    const chosen = ready.pop();
    order.push(chosen);
    for (const successor of slots[chosen]!.successors) {
      if (--slots[successor]!.waiting === 0) ready.push(successor);
    }
  }
  if (order.length !== span) throw new Error(`block ${block.label} has a cyclic schedule`);
  if (order.every((at, position) => at === position)) return false;

  block.instructions.splice(
    start,
    span,
    ...order.map((at) => block.instructions[start + at]!),
  );
  return true;
}

export function scheduleMachineCode(fn: MachineFunction, lowering: MachineLowering): number {
  let reordered = 0;
  for (const block of fn.blocks) {
    for (const [start, end] of regionsOf(block)) {
      if (scheduleRegion(block, lowering, start, end)) reordered++;
    }
  }
  return reordered;
}
