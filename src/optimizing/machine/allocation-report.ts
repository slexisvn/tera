import type { Allocation } from "./linear-scan.js";
import type { LiveInterval, Liveness } from "./liveness.js";
import type { MachineFunction, MachineRegister } from "./ir.js";

export interface AllocationRangeReport {
  readonly from: number;
  readonly to: number;
}

export interface AllocationIntervalReport {
  readonly register: string;
  readonly kind: "virtual" | "physical";
  readonly assigned: string | null;
  readonly spillSlot: number | null;
  readonly spilled: boolean;
  readonly ranges: readonly AllocationRangeReport[];
  readonly uses: readonly number[];
}

export interface AllocationBlockReport {
  readonly label: string;
  readonly from: number;
  readonly to: number;
}

export interface AllocationInstructionReport {
  readonly position: number;
  readonly opcode: string;
}

export interface AllocationReport {
  readonly symbol: string;
  readonly first: number;
  readonly last: number;
  readonly blocks: readonly AllocationBlockReport[];
  readonly instructions: readonly AllocationInstructionReport[];
  readonly intervals: readonly AllocationIntervalReport[];
  readonly usedCalleeSaved: readonly string[];
  readonly spilledCount: number;
  readonly splitCount: number;
}

export type AllocationTracer = (report: AllocationReport) => void;

export function registerName(register: MachineRegister): string {
  return register.kind === "physical" ? register.name : `v${register.id}`;
}

function intervalReport(interval: LiveInterval, spilled: ReadonlySet<LiveInterval>): AllocationIntervalReport {
  return {
    register: registerName(interval.register),
    kind: interval.register.kind,
    assigned: interval.assigned === null ? null : interval.assigned.name,
    spillSlot: interval.spillSlot === null ? null : interval.spillSlot.id,
    spilled: spilled.has(interval),
    ranges: interval.ranges.map((range) => ({ from: range.from, to: range.to })),
    uses: interval.uses.map((use) => use.position),
  };
}

export function allocationReport(
  symbol: string,
  fn: MachineFunction,
  liveness: Liveness,
  allocation: Allocation,
): AllocationReport {
  const spilled = new Set(allocation.spilled);
  const intervals = [...liveness.virtualIntervals, ...liveness.fixedIntervals]
    .filter((interval) => !interval.isEmpty)
    .map((interval) => intervalReport(interval, spilled));

  const instructions: AllocationInstructionReport[] = [];
  for (const block of fn.blocks) {
    for (const node of block.instructions) {
      instructions.push({ position: node.position, opcode: node.opcode });
    }
  }

  const bounds = fn.blocks.filter((block) => block.instructions.length > 0);
  return {
    symbol,
    first: bounds.length === 0 ? 0 : Math.min(...bounds.map((block) => block.from)),
    last: bounds.length === 0 ? 0 : Math.max(...bounds.map((block) => block.to)),
    blocks: bounds.map((block) => ({ label: block.label, from: block.from, to: block.to })),
    instructions,
    intervals,
    usedCalleeSaved: allocation.usedCalleeSaved.map((register) => register.name),
    spilledCount: allocation.spilled.length,
    splitCount: allocation.splitRegisters.length,
  };
}
