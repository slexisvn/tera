import { BackendLoweringError } from "../target/errors.js";
import type { MachineTargetModel } from "../target/model.js";
import type { PhysicalRegister } from "../target/registers.js";
import {
  def,
  isVirtual,
  use,
  type MachineBlock,
  type MachineFunction,
  type MachineInstruction,
  type VirtualRegister,
} from "./ir.js";
import type { Allocation } from "./linear-scan.js";
import type { LiveInterval } from "./liveness.js";
import type { MachineLowering } from "./lowering.js";
import { sequenceParallelCopies } from "./parallel-copy.js";

export class UnresolvableEdgeError extends BackendLoweringError {
  constructor(pred: MachineBlock, succ: MachineBlock) {
    super(`${pred.label} -> ${succ.label} is a critical edge and cannot carry a split interval`);
    this.name = "UnresolvableEdgeError";
  }
}

interface CarriedValue {
  readonly register: VirtualRegister;
  readonly from: LiveInterval;
  readonly to: LiveInterval;
}

function differingLocation(
  register: VirtualRegister,
  from: LiveInterval | undefined,
  to: LiveInterval | undefined,
): CarriedValue | null {
  if (from === undefined || to === undefined || from === to) return null;
  if (from.assigned !== null && from.assigned === to.assigned) return null;
  if (from.assigned === null && to.assigned === null) return null;
  return { register, from, to };
}

class Resolver {
  private readonly emitted = new Map<MachineBlock, Map<number, MachineInstruction[]>>();
  private readonly usedScratch = new Set<PhysicalRegister>();
  private readonly blockStarts = new Set<number>();
  private readonly blockAt: readonly MachineBlock[];

  constructor(
    private readonly fn: MachineFunction,
    private readonly target: MachineTargetModel,
    private readonly lowering: MachineLowering,
    private readonly allocation: Allocation,
  ) {
    const blockAt: MachineBlock[] = [];
    for (const block of fn.blocks) {
      this.blockStarts.add(block.from);
      for (const node of block.instructions) blockAt[node.position] = block;
    }
    this.blockAt = blockAt;
  }

  run(): readonly PhysicalRegister[] {
    this.resolveEdges();
    this.resolveWithinBlocks();
    this.flush();
    return [...this.usedScratch];
  }

  private resolveEdges(): void {
    for (const pred of this.fn.blocks) {
      for (const succ of pred.successors) {
        const carried: CarriedValue[] = [];
        for (const register of this.allocation.splitRegisters) {
          if (!isVirtual(register)) continue;
          const value = differingLocation(
            register,
            this.allocation.locationAt(register, pred.to - 1),
            this.allocation.locationAt(register, succ.from),
          );
          if (value !== null) carried.push(value);
        }
        if (carried.length === 0) continue;
        this.placeOnEdge(pred, succ, this.movesFor(carried));
      }
    }
  }

  private resolveWithinBlocks(): void {
    for (const register of this.allocation.splitRegisters) {
      if (!isVirtual(register)) continue;
      const parts = this.allocation.intervals
        .filter((part) => part.register === register)
        .sort((left, right) => left.start - right.start);
      for (let index = 1; index < parts.length; index++) {
        const to = parts[index]!;
        const from = parts[index - 1]!;
        if (from.end !== to.start || this.blockStarts.has(to.start)) continue;
        const value = differingLocation(register, from, to);
        if (value === null) continue;
        this.at(this.blockAt[to.start]!, to.start).push(...this.movesFor([value]));
      }
    }
  }

  private at(block: MachineBlock, position: number): MachineInstruction[] {
    const byPosition = this.emitted.get(block) ?? new Map<number, MachineInstruction[]>();
    this.emitted.set(block, byPosition);
    const existing = byPosition.get(position) ?? [];
    byPosition.set(position, existing);
    return existing;
  }

  private movesFor(carried: readonly CarriedValue[]): MachineInstruction[] {
    const moves: MachineInstruction[] = [];
    const widthOf = new Map<PhysicalRegister, number>();
    const copies: Array<{ destination: PhysicalRegister; source: PhysicalRegister }> = [];

    for (const value of carried) {
      const width = value.register.width;
      if (value.to.assigned === null) {
        moves.push(this.lowering.spill(value.to.spillSlot!, use(value.from.assigned!, width)));
        continue;
      }
      if (value.from.assigned === null) continue;
      widthOf.set(value.to.assigned, width);
      widthOf.set(value.from.assigned, width);
      copies.push({ destination: value.to.assigned, source: value.from.assigned });
    }

    sequenceParallelCopies(
      copies,
      (destination, source) => {
        const width = widthOf.get(destination) ?? widthOf.get(source)!;
        moves.push(this.lowering.copy(def(destination, width), use(source, width)));
      },
      (like) => {
        const scratch = this.target.registers.classOf(like.classId).scratch[0];
        if (scratch === undefined) {
          throw new BackendLoweringError(
            `${like.classId} reserves no scratch register for split resolution`,
          );
        }
        this.usedScratch.add(scratch);
        widthOf.set(scratch, widthOf.get(like)!);
        return scratch;
      },
    );

    for (const value of carried) {
      if (value.from.assigned !== null || value.to.assigned === null) continue;
      moves.push(
        this.lowering.reload(
          def(value.to.assigned, value.register.width),
          value.from.spillSlot!,
        ),
      );
    }
    return moves;
  }

  private placeOnEdge(
    pred: MachineBlock,
    succ: MachineBlock,
    moves: readonly MachineInstruction[],
  ): void {
    if (succ.predecessors.length === 1) {
      this.at(succ, succ.from).push(...moves);
      return;
    }
    if (pred.successors.length === 1) {
      let at = pred.instructions.length;
      while (at > 0 && pred.instructions[at - 1]!.flags.terminator === true) at--;
      const anchor = pred.instructions[at];
      this.at(pred, anchor === undefined ? pred.to : anchor.position).push(...moves);
      return;
    }
    throw new UnresolvableEdgeError(pred, succ);
  }

  private flush(): void {
    for (const [block, byPosition] of this.emitted) {
      const rewritten: MachineInstruction[] = [];
      for (const node of block.instructions) {
        const before = byPosition.get(node.position);
        if (before !== undefined) rewritten.push(...before);
        rewritten.push(node);
      }
      const trailing = byPosition.get(block.to);
      if (trailing !== undefined) rewritten.push(...trailing);
      block.instructions.length = 0;
      block.instructions.push(...rewritten);
    }
  }
}

export function resolveSplitIntervals(
  fn: MachineFunction,
  target: MachineTargetModel,
  lowering: MachineLowering,
  allocation: Allocation,
): readonly PhysicalRegister[] {
  if (allocation.splitRegisters.length === 0) return [];
  return new Resolver(fn, target, lowering, allocation).run();
}
