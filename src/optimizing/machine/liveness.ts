import type { PhysicalRegister } from "../target/registers.js";
import {
  definedOperandsOf,
  usedOperandsOf,
  type MachineBlock,
  type MachineFunction,
  type MachineRegister,
  type StackSlot,
} from "./ir.js";

export interface LiveRange {
  from: number;
  to: number;
}

export class LiveInterval {
  readonly ranges: LiveRange[] = [];
  readonly fixed: boolean;
  assigned: PhysicalRegister | null;
  spillSlot: StackSlot | null = null;

  constructor(readonly register: MachineRegister) {
    this.fixed = register.kind === "physical";
    this.assigned = register.kind === "physical" ? register : null;
  }

  get start(): number {
    return this.ranges.length === 0 ? -1 : this.ranges[0]!.from;
  }

  get end(): number {
    return this.ranges.length === 0 ? -1 : this.ranges[this.ranges.length - 1]!.to;
  }

  get isEmpty(): boolean {
    return this.ranges.length === 0;
  }

  addRange(from: number, to: number): void {
    if (to <= from) return;
    const first = this.ranges[0];
    if (first === undefined || to < first.from) {
      this.ranges.unshift({ from, to });
      return;
    }
    first.from = Math.min(first.from, from);
    first.to = Math.max(first.to, to);
    while (this.ranges.length > 1 && this.ranges[1]!.from <= first.to) {
      first.to = Math.max(first.to, this.ranges[1]!.to);
      this.ranges.splice(1, 1);
    }
  }

  setFrom(position: number): void {
    const first = this.ranges[0];
    if (first === undefined || position < first.from) {
      this.ranges.unshift({ from: position, to: position + 1 });
      return;
    }
    if (position < first.to) first.from = position;
  }

  covers(position: number): boolean {
    for (const range of this.ranges) {
      if (position < range.from) return false;
      if (position < range.to) return true;
    }
    return false;
  }

  intersectionWith(other: LiveInterval): number {
    let left = 0;
    let right = 0;
    while (left < this.ranges.length && right < other.ranges.length) {
      const a = this.ranges[left]!;
      const b = other.ranges[right]!;
      const from = Math.max(a.from, b.from);
      const to = Math.min(a.to, b.to);
      if (from < to) return from;
      if (a.to <= b.to) left++;
      else right++;
    }
    return -1;
  }
}

export interface Liveness {
  readonly virtualIntervals: readonly LiveInterval[];
  readonly fixedIntervals: readonly LiveInterval[];
  intervalOf(register: MachineRegister): LiveInterval | undefined;
}

export function assignPositions(fn: MachineFunction): void {
  let position = 0;
  for (const block of fn.blocks) {
    block.from = position;
    for (const node of block.instructions) {
      node.position = position;
      position += 2;
    }
    block.to = position;
  }
}

function naturalLoopEnd(header: MachineBlock, latch: MachineBlock): number {
  const body = new Set<MachineBlock>([header, latch]);
  const pending: MachineBlock[] = [latch];
  while (pending.length > 0) {
    for (const predecessor of pending.pop()!.predecessors) {
      if (body.has(predecessor)) continue;
      body.add(predecessor);
      pending.push(predecessor);
    }
  }
  let end = 0;
  for (const block of body) end = Math.max(end, block.to);
  return end;
}

function loopEndsOf(fn: MachineFunction): Map<number, number> {
  const order = new Map<number, number>();
  fn.blocks.forEach((block, index) => order.set(block.id, index));
  const ends = new Map<number, number>();
  for (const block of fn.blocks) {
    const index = order.get(block.id)!;
    for (const successor of block.successors) {
      if (order.get(successor.id)! > index) continue;
      const end = naturalLoopEnd(successor, block);
      const previous = ends.get(successor.id) ?? 0;
      if (end > previous) ends.set(successor.id, end);
    }
  }
  return ends;
}

export function computeLiveness(fn: MachineFunction): Liveness {
  const intervals = new Map<MachineRegister, LiveInterval>();
  const intervalFor = (register: MachineRegister): LiveInterval => {
    const existing = intervals.get(register);
    if (existing !== undefined) return existing;
    const created = new LiveInterval(register);
    intervals.set(register, created);
    return created;
  };

  const loopEnds = loopEndsOf(fn);
  const liveIn = new Map<number, Set<MachineRegister>>();

  for (let index = fn.blocks.length - 1; index >= 0; index--) {
    const block = fn.blocks[index]!;
    const live = new Set<MachineRegister>();
    for (const successor of block.successors) {
      for (const register of liveIn.get(successor.id) ?? []) live.add(register);
    }
    for (const register of live) intervalFor(register).addRange(block.from, block.to);

    for (let at = block.instructions.length - 1; at >= 0; at--) {
      const node = block.instructions[at]!;
      for (const operand of definedOperandsOf(node)) {
        intervalFor(operand.register).setFrom(node.position);
        live.delete(operand.register);
      }
      for (const operand of usedOperandsOf(node)) {
        intervalFor(operand.register).addRange(block.from, node.position + 1);
        live.add(operand.register);
      }
    }

    const loopEnd = loopEnds.get(block.id);
    if (loopEnd !== undefined) {
      for (const register of live) intervalFor(register).addRange(block.from, loopEnd);
    }
    liveIn.set(block.id, live);
  }

  const virtualIntervals: LiveInterval[] = [];
  const fixedIntervals: LiveInterval[] = [];
  for (const interval of intervals.values()) {
    if (interval.isEmpty) continue;
    if (interval.fixed) fixedIntervals.push(interval);
    else virtualIntervals.push(interval);
  }
  virtualIntervals.sort((left, right) => left.start - right.start || left.end - right.end);

  return {
    virtualIntervals,
    fixedIntervals,
    intervalOf: (register) => intervals.get(register),
  };
}
