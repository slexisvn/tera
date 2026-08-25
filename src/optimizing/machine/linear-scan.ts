import type { PhysicalRegister } from "../target/registers.js";
import type { MachineTargetModel } from "../target/model.js";
import { PriorityQueue } from "../infra/priority-queue.js";
import {
  isVirtual,
  type MachineBlock,
  type MachineFunction,
  type MachineRegister,
  type StackSlot,
} from "./ir.js";
import type { Liveness, LiveInterval } from "./liveness.js";

export interface Allocation {
  readonly intervals: readonly LiveInterval[];
  readonly spilled: readonly LiveInterval[];
  readonly splitRegisters: readonly MachineRegister[];
  readonly usedCalleeSaved: readonly PhysicalRegister[];
  locationAt(register: MachineRegister, position: number): LiveInterval | undefined;
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const NO_SPLIT = -1;
const RELOAD_BREAK_EVEN_USES = 2;

function placeableEdge(pred: MachineBlock, succ: MachineBlock): boolean {
  if (pred === succ) return false;
  return succ.predecessors.length === 1 || pred.successors.length === 1;
}

function firstAbove(starts: readonly number[], limit: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle]! > limit) high = middle;
    else low = middle + 1;
  }
  return low;
}

function resolvableBoundaries(fn: MachineFunction): readonly number[] {
  const starts: number[] = [];
  for (const block of fn.blocks) {
    if (block.predecessors.length === 0 && block.instructions.length > 0) {
      for (const node of block.instructions.slice(1)) starts.push(node.position);
      continue;
    }
    for (const node of block.instructions) starts.push(node.position);
  }
  starts.sort((left, right) => left - right);
  const crossed = new Array<number>(starts.length + 1).fill(0);
  const forbid = (after: number, upTo: number): void => {
    const first = firstAbove(starts, after);
    const last = firstAbove(starts, upTo) - 1;
    if (first > last) return;
    crossed[first]!++;
    crossed[last + 1]!--;
  };
  for (const pred of fn.blocks) {
    for (const succ of pred.successors) {
      if (placeableEdge(pred, succ)) continue;
      if (pred.to <= succ.from) forbid(pred.to - 1, succ.from);
      else forbid(succ.from, pred.to - 1);
    }
  }
  const resolvable: number[] = [];
  let running = 0;
  starts.forEach((start, index) => {
    running += crossed[index]!;
    if (running === 0) resolvable.push(start);
  });
  return resolvable;
}

class LinearScan {
  private readonly active: LiveInterval[] = [];
  private readonly inactive: LiveInterval[] = [];
  private readonly slots = new Map<MachineRegister, StackSlot>();
  private readonly byRegister = new Map<MachineRegister, LiveInterval[]>();
  private readonly boundaries: readonly number[];

  constructor(
    private readonly fn: MachineFunction,
    private readonly target: MachineTargetModel,
    private readonly liveness: Liveness,
    splitting: boolean,
  ) {
    this.boundaries = splitting ? resolvableBoundaries(fn) : [];
  }

  run(): Allocation {
    const unhandled = new PriorityQueue<LiveInterval>(
      (left, right) => left.start - right.start,
      this.liveness.virtualIntervals,
    );
    for (const interval of this.liveness.virtualIntervals) this.track(interval);
    this.inactive.push(...this.liveness.fixedIntervals);

    for (;;) {
      const current = unhandled.take();
      if (current === undefined) break;
      this.advance(current.start);
      if (!this.allocateFree(current)) this.allocateBlocked(current, unhandled);
      if (current.assigned !== null) this.active.push(current);
    }

    const intervals = [...this.byRegister.values()].flat();
    const splitRegisters: MachineRegister[] = [];
    for (const [register, parts] of this.byRegister) {
      if (parts.length > 1) splitRegisters.push(register);
    }
    return {
      intervals,
      spilled: intervals.filter((interval) => interval.spillSlot !== null),
      splitRegisters,
      usedCalleeSaved: this.calleeSavedInUse(intervals),
      locationAt: (register, position) => this.locationAt(register, position),
    };
  }

  private locationAt(register: MachineRegister, position: number): LiveInterval | undefined {
    const parts = this.byRegister.get(register);
    if (parts === undefined) return undefined;
    let before: LiveInterval | undefined;
    let after: LiveInterval | undefined;
    for (const part of parts) {
      if (part.covers(position)) return part;
      if (part.start <= position) {
        if (before === undefined || part.start > before.start) before = part;
      } else if (after === undefined || part.start < after.start) {
        after = part;
      }
    }
    return before ?? after;
  }

  private track(interval: LiveInterval): void {
    const parts = this.byRegister.get(interval.register);
    if (parts === undefined) this.byRegister.set(interval.register, [interval]);
    else parts.push(interval);
  }

  private splitPositionFor(interval: LiveInterval, limit: number): number {
    let best = NO_SPLIT;
    for (const boundary of this.boundaries) {
      if (boundary > limit) break;
      if (!interval.splittableAt(boundary)) continue;
      best = boundary;
    }
    return best;
  }



  private split(
    interval: LiveInterval,
    position: number,
    unhandled: PriorityQueue<LiveInterval>,
  ): void {
    const child = interval.splitAt(position);
    child.hint = interval.assigned;
    this.track(child);
    unhandled.push(child);
  }

  private advance(position: number): void {
    for (let index = this.active.length - 1; index >= 0; index--) {
      const interval = this.active[index]!;
      if (interval.end > position && interval.covers(position)) continue;
      this.active.splice(index, 1);
      if (interval.end > position) this.inactive.push(interval);
    }
    for (let index = this.inactive.length - 1; index >= 0; index--) {
      const interval = this.inactive[index]!;
      if (interval.end <= position) {
        this.inactive.splice(index, 1);
        continue;
      }
      if (!interval.covers(position)) continue;
      this.inactive.splice(index, 1);
      this.active.push(interval);
    }
  }

  private *occupied(): Iterable<LiveInterval> {
    yield* this.active;
    yield* this.inactive;
  }

  private sameClass(interval: LiveInterval, current: LiveInterval): boolean {
    return (
      interval.assigned !== null &&
      interval.assigned.classId === current.register.classId
    );
  }

  private freeUntilOf(current: LiveInterval): Map<PhysicalRegister, number> {
    const registerClass = this.target.registers.classOf(current.register.classId);
    const freeUntil = new Map<PhysicalRegister, number>();
    for (const register of registerClass.allocation) freeUntil.set(register, UNBOUNDED);

    for (const interval of this.active) {
      if (!this.sameClass(interval, current)) continue;
      if (freeUntil.has(interval.assigned!)) freeUntil.set(interval.assigned!, 0);
    }
    for (const interval of this.inactive) {
      if (!this.sameClass(interval, current)) continue;
      const known = freeUntil.get(interval.assigned!);
      if (known === undefined) continue;
      const at = interval.intersectionWith(current);
      if (at < 0) continue;
      freeUntil.set(interval.assigned!, Math.min(known, at));
    }
    return freeUntil;
  }

  private hintOf(current: LiveInterval): PhysicalRegister | null {
    const hint = current.hint;
    if (hint === null) return null;
    if (hint.kind === "physical") {
      return hint.classId === current.register.classId ? hint : null;
    }
    return this.liveness.intervalOf(hint)?.assigned ?? null;
  }

  private takeHinted(
    current: LiveInterval,
    freeUntil: ReadonlyMap<PhysicalRegister, number>,
  ): boolean {
    const hinted = this.hintOf(current);
    if (hinted === null || !freeUntil.has(hinted)) return false;
    if (freeUntil.get(hinted)! > current.end) {
      current.assigned = hinted;
      return true;
    }

    let blocker: LiveInterval | null = null;
    for (const interval of this.occupied()) {
      if (interval.assigned !== hinted) continue;
      if (interval.intersectionWith(current) < 0) continue;
      if (blocker !== null) return false;
      blocker = interval;
    }
    if (blocker === null || blocker.register !== current.hint) return false;

    const copied =
      current.start === current.hintAt && blocker.end === current.hintAt + 1
        ? blocker
        : current.end === current.hintAt + 1 && blocker.start === current.hintAt
          ? current
          : null;
    if (copied === null || !copied.shortenTo(current.hintAt)) return false;
    current.assigned = hinted;
    return true;
  }

  private allocateFree(current: LiveInterval): boolean {
    const registerClass = this.target.registers.classOf(current.register.classId);
    const freeUntil = this.freeUntilOf(current);
    if (this.takeHinted(current, freeUntil)) return true;

    let best: PhysicalRegister | null = null;
    let bestUntil = 0;
    for (const register of registerClass.allocation) {
      const until = freeUntil.get(register) ?? 0;
      if (until <= bestUntil) continue;
      best = register;
      bestUntil = until;
    }
    if (best === null || bestUntil <= current.end) return false;
    current.assigned = best;
    return true;
  }

  private allocateBlocked(
    current: LiveInterval,
    unhandled: PriorityQueue<LiveInterval>,
  ): void {
    const registerClass = this.target.registers.classOf(current.register.classId);
    const blocked = new Set<PhysicalRegister>();
    const conflictsOf = new Map<PhysicalRegister, LiveInterval[]>();

    for (const interval of this.occupied()) {
      if (!this.sameClass(interval, current)) continue;
      if (interval.intersectionWith(current) < 0) continue;
      const register = interval.assigned!;
      if (interval.fixed || interval.start >= current.start) {
        blocked.add(register);
        continue;
      }
      const conflicts = conflictsOf.get(register);
      if (conflicts === undefined) conflictsOf.set(register, [interval]);
      else conflicts.push(interval);
    }

    let victim: PhysicalRegister | null = null;
    let cheapest = current.densityFrom(current.start);
    for (const register of registerClass.allocation) {
      if (blocked.has(register)) continue;
      let cost = 0;
      for (const interval of conflictsOf.get(register) ?? []) {
        cost += interval.densityFrom(current.start);
      }
      if (cost >= cheapest) continue;
      victim = register;
      cheapest = cost;
    }
    if (victim === null) {
      const nextUse = current.firstUseAfter(current.start);
      const at = nextUse < 0 ? NO_SPLIT : this.splitPositionFor(current, nextUse);
      if (at !== NO_SPLIT && current.useCountFrom(at) >= RELOAD_BREAK_EVEN_USES) {
        this.split(current, at, unhandled);
      }
      this.spill(current);
      return;
    }

    for (const interval of conflictsOf.get(victim) ?? []) {
      this.spill(interval);
      this.retire(interval);
    }
    current.assigned = victim;
  }

  private retire(interval: LiveInterval): void {
    const running = this.active.indexOf(interval);
    if (running >= 0) this.active.splice(running, 1);
    const idle = this.inactive.indexOf(interval);
    if (idle >= 0) this.inactive.splice(idle, 1);
  }

  private spill(interval: LiveInterval): void {
    if (interval.spillSlot !== null) return;
    interval.assigned = null;
    interval.spillSlot = this.slotFor(interval.register);
  }

  private slotFor(register: MachineRegister): StackSlot {
    const existing = this.slots.get(register);
    if (existing !== undefined) return existing;
    const width = isVirtual(register) ? register.width : this.target.abi.pointerWidthBytes;
    const created = this.fn.createSlot(width, width);
    this.slots.set(register, created);
    return created;
  }

  private calleeSavedInUse(intervals: readonly LiveInterval[]): readonly PhysicalRegister[] {
    const preserved = new Set(this.target.abi.callingConvention.calleeSaved);
    const used = new Set<PhysicalRegister>();
    for (const interval of intervals) {
      if (interval.assigned !== null && preserved.has(interval.assigned)) {
        used.add(interval.assigned);
      }
    }
    return [...used];
  }
}

export function allocateRegisters(
  fn: MachineFunction,
  target: MachineTargetModel,
  liveness: Liveness,
  splitting = false,
): Allocation {
  return new LinearScan(fn, target, liveness, splitting).run();
}
