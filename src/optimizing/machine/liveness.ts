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

export interface UsePosition {
  readonly position: number;
  readonly weight: number;
}

const LOOP_WEIGHT_FACTOR = 2;
const LOOP_DEPTH_LIMIT = 4;

function loopWeightOf(depth: number): number {
  return LOOP_WEIGHT_FACTOR ** Math.min(depth, LOOP_DEPTH_LIMIT);
}

export class LiveInterval {
  readonly ranges: LiveRange[] = [];
  readonly uses: UsePosition[] = [];
  readonly fixed: boolean;
  assigned: PhysicalRegister | null;
  spillSlot: StackSlot | null = null;
  hint: MachineRegister | null = null;
  hintAt = -1;

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

  addUse(position: number, weight: number): void {
    this.uses.push({ position, weight });
  }

  orderUses(): void {
    this.uses.reverse();
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

  weightFrom(position: number): number {
    let total = 0;
    for (let index = this.uses.length - 1; index >= 0; index--) {
      const at = this.uses[index]!;
      if (at.position < position) break;
      total += at.weight;
    }
    return total;
  }

  densityFrom(position: number): number {
    const span = this.end - Math.max(position, this.start);
    return span <= 0 ? Number.POSITIVE_INFINITY : this.weightFrom(position) / span;
  }

  useCountFrom(position: number): number {
    let total = 0;
    for (const at of this.uses) {
      if (at.position >= position) total++;
    }
    return total;
  }

  firstUseAfter(position: number): number {
    for (const at of this.uses) {
      if (at.position > position) return at.position;
    }
    return -1;
  }

  splittableAt(position: number): boolean {
    return this.ranges.some((range) => range.from < position && position < range.to);
  }

  splitAt(position: number): LiveInterval {
    const child = new LiveInterval(this.register);
    const kept: LiveRange[] = [];
    for (const range of this.ranges) {
      if (range.to <= position) {
        kept.push(range);
        continue;
      }
      if (range.from >= position) {
        child.ranges.push(range);
        continue;
      }
      kept.push({ from: range.from, to: position });
      child.ranges.push({ from: position, to: range.to });
    }
    this.ranges.length = 0;
    this.ranges.push(...kept);
    const keptUses: UsePosition[] = [];
    for (const at of this.uses) {
      if (at.position < position) keptUses.push(at);
      else child.uses.push(at);
    }
    this.uses.length = 0;
    this.uses.push(...keptUses);
    return child;
  }

  shortenTo(position: number): boolean {
    const last = this.ranges[this.ranges.length - 1]!;
    if (last.from >= position) return false;
    last.to = position;
    return true;
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

interface LoopInfo {
  readonly ends: ReadonlyMap<number, number>;
  readonly depths: ReadonlyMap<number, number>;
}

function loopBodyOf(header: MachineBlock, latch: MachineBlock): Set<MachineBlock> {
  const body = new Set<MachineBlock>([header, latch]);
  const pending: MachineBlock[] = [latch];
  while (pending.length > 0) {
    for (const predecessor of pending.pop()!.predecessors) {
      if (body.has(predecessor)) continue;
      body.add(predecessor);
      pending.push(predecessor);
    }
  }
  return body;
}

function loopsOf(fn: MachineFunction): LoopInfo {
  const order = new Map<number, number>();
  fn.blocks.forEach((block, index) => order.set(block.id, index));
  const ends = new Map<number, number>();
  const depths = new Map<number, number>();
  for (const block of fn.blocks) {
    const index = order.get(block.id)!;
    for (const successor of block.successors) {
      if (order.get(successor.id)! > index) continue;
      let end = 0;
      for (const member of loopBodyOf(successor, block)) {
        end = Math.max(end, member.to);
        depths.set(member.id, (depths.get(member.id) ?? 0) + 1);
      }
      if (end > (ends.get(successor.id) ?? 0)) ends.set(successor.id, end);
    }
  }
  return { ends, depths };
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
  const hintTo = (
    interval: LiveInterval,
    register: MachineRegister,
    position: number,
  ): void => {
    if (interval.fixed) return;
    if (interval.hint !== null && interval.hint.kind === "physical") return;
    if (interval.hint !== null && register.kind === "virtual") return;
    interval.hint = register;
    interval.hintAt = position;
  };

  const loops = loopsOf(fn);
  const liveIn = new Map<number, Set<MachineRegister>>();

  for (let index = fn.blocks.length - 1; index >= 0; index--) {
    const block = fn.blocks[index]!;
    const weight = loopWeightOf(loops.depths.get(block.id) ?? 0);
    const live = new Set<MachineRegister>();
    for (const successor of block.successors) {
      for (const register of liveIn.get(successor.id) ?? []) live.add(register);
    }
    for (const register of live) intervalFor(register).addRange(block.from, block.to);

    for (let at = block.instructions.length - 1; at >= 0; at--) {
      const node = block.instructions[at]!;
      for (const operand of definedOperandsOf(node)) {
        const interval = intervalFor(operand.register);
        interval.setFrom(node.position);
        interval.addUse(node.position, weight);
        live.delete(operand.register);
      }
      for (const operand of usedOperandsOf(node)) {
        const interval = intervalFor(operand.register);
        interval.addRange(block.from, node.position + 1);
        interval.addUse(node.position, weight);
        live.add(operand.register);
      }
      if (node.flags.copy !== true) continue;
      const [destination, source] = node.operands;
      if (destination?.kind !== "register" || source?.kind !== "register") continue;
      hintTo(intervalFor(destination.register), source.register, node.position);
      hintTo(intervalFor(source.register), destination.register, node.position);
    }

    const loopEnd = loops.ends.get(block.id);
    if (loopEnd !== undefined) {
      for (const register of live) intervalFor(register).addRange(block.from, loopEnd);
    }
    liveIn.set(block.id, live);
  }

  const virtualIntervals: LiveInterval[] = [];
  const fixedIntervals: LiveInterval[] = [];
  for (const interval of intervals.values()) {
    if (interval.isEmpty) continue;
    interval.orderUses();
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
