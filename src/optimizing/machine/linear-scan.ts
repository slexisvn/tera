import type { PhysicalRegister } from "../target/registers.js";
import type { MachineTargetModel } from "../target/model.js";
import type { MachineFunction } from "./ir.js";
import type { Liveness, LiveInterval } from "./liveness.js";

export interface Allocation {
  readonly intervals: readonly LiveInterval[];
  readonly spilled: readonly LiveInterval[];
  readonly usedCalleeSaved: readonly PhysicalRegister[];
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

class LinearScan {
  private readonly active: LiveInterval[] = [];
  private readonly inactive: LiveInterval[] = [];
  private readonly spilled: LiveInterval[] = [];

  constructor(
    private readonly fn: MachineFunction,
    private readonly target: MachineTargetModel,
    private readonly liveness: Liveness,
  ) {}

  run(): Allocation {
    this.inactive.push(...this.liveness.fixedIntervals);
    for (const current of this.liveness.virtualIntervals) {
      this.advance(current.start);
      if (!this.allocateFree(current)) this.allocateBlocked(current);
      if (current.assigned !== null) this.active.push(current);
    }
    return {
      intervals: this.liveness.virtualIntervals,
      spilled: this.spilled,
      usedCalleeSaved: this.calleeSavedInUse(),
    };
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

  private sameClass(interval: LiveInterval, current: LiveInterval): boolean {
    return (
      interval.assigned !== null &&
      interval.assigned.classId === current.register.classId
    );
  }

  private allocateFree(current: LiveInterval): boolean {
    const registerClass = this.target.registers.classOf(current.register.classId);
    const freeUntil = new Map<PhysicalRegister, number>();
    for (const register of registerClass.allocation) freeUntil.set(register, UNBOUNDED);

    for (const interval of this.active) {
      if (!this.sameClass(interval, current)) continue;
      freeUntil.set(interval.assigned!, 0);
    }
    for (const interval of this.inactive) {
      if (!this.sameClass(interval, current)) continue;
      const at = interval.intersectionWith(current);
      if (at < 0) continue;
      freeUntil.set(interval.assigned!, Math.min(freeUntil.get(interval.assigned!) ?? at, at));
    }

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

  private allocateBlocked(current: LiveInterval): void {
    const registerClass = this.target.registers.classOf(current.register.classId);
    const blocked = new Set<PhysicalRegister>();
    for (const interval of [...this.active, ...this.inactive]) {
      if (!interval.fixed || !this.sameClass(interval, current)) continue;
      if (interval.intersectionWith(current) >= 0) blocked.add(interval.assigned!);
    }

    const conflicts = [...this.active, ...this.inactive].filter(
      (interval) =>
        !interval.fixed &&
        this.sameClass(interval, current) &&
        !blocked.has(interval.assigned!) &&
        interval.intersectionWith(current) >= 0,
    );

    let furthest: LiveInterval | null = null;
    for (const interval of conflicts) {
      if (furthest === null || interval.end > furthest.end) furthest = interval;
    }
    if (furthest === null || furthest.end <= current.end) {
      this.spill(current);
      return;
    }

    const target = furthest.assigned!;
    for (const interval of conflicts) {
      if (interval.assigned !== target) continue;
      this.spill(interval);
      const index = this.active.indexOf(interval);
      if (index >= 0) this.active.splice(index, 1);
      const idle = this.inactive.indexOf(interval);
      if (idle >= 0) this.inactive.splice(idle, 1);
    }
    current.assigned = target;
  }

  private spill(interval: LiveInterval): void {
    if (interval.spillSlot !== null) return;
    const width =
      interval.register.kind === "virtual"
        ? interval.register.width
        : this.target.abi.pointerWidthBytes;
    interval.assigned = null;
    interval.spillSlot = this.fn.createSlot(width, width);
    this.spilled.push(interval);
  }

  private calleeSavedInUse(): readonly PhysicalRegister[] {
    const preserved = new Set(this.target.abi.callingConvention.calleeSaved);
    const used = new Set<PhysicalRegister>();
    for (const interval of this.liveness.virtualIntervals) {
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
): Allocation {
  return new LinearScan(fn, target, liveness).run();
}
