import type { MachineTargetModel } from "../target/model.js";
import type { PhysicalRegister, RegisterClassId } from "../target/registers.js";
import { BackendLoweringError } from "../target/errors.js";
import {
  def,
  isVirtual,
  registerOperandsOf,
  use,
  type MachineFunction,
  type MachineInstruction,
  type OperandRole,
  type RegisterOperand,
  type StackSlot,
  type VirtualRegister,
} from "./ir.js";
import type { MachineLowering } from "./lowering.js";
import type { Allocation } from "./linear-scan.js";
import { resolveSplitIntervals } from "./resolve.js";
import type { LiveInterval } from "./liveness.js";

export class OutOfScratchRegistersError extends BackendLoweringError {
  constructor(opcode: string, classId: RegisterClassId) {
    super(`${opcode} needs more spilled ${classId} operands than the target reserves`);
    this.name = "OutOfScratchRegistersError";
  }
}

function isRedundantCopy(node: MachineInstruction): boolean {
  if (node.flags.copy !== true) return false;
  const [destination, source] = node.operands;
  return (
    destination !== undefined &&
    destination.kind === "register" &&
    source !== undefined &&
    source.kind === "register" &&
    destination.register === source.register
  );
}

function locationOf(
  allocation: Allocation,
  node: MachineInstruction,
  register: VirtualRegister,
): LiveInterval {
  const part = allocation.locationAt(register, node.position);
  if (part === undefined) {
    throw new Error(`v${register.id} has no live range at ${node.opcode}`);
  }
  return part;
}

function applyAssignment(allocation: Allocation, node: MachineInstruction): void {
  for (const operand of registerOperandsOf(node)) {
    const register = operand.register;
    if (!isVirtual(register)) continue;
    const physical = locationOf(allocation, node, register).assigned;
    if (physical === null) {
      throw new Error(`v${register.id} survived allocation without a register`);
    }
    operand.register = physical;
  }
}

export function rewriteAllocations(
  fn: MachineFunction,
  target: MachineTargetModel,
  lowering: MachineLowering,
  allocation: Allocation,
): readonly PhysicalRegister[] {
  const usedScratch = new Set<PhysicalRegister>(
    resolveSplitIntervals(fn, target, lowering, allocation),
  );
  const spillSlotAt = (node: MachineInstruction, operand: RegisterOperand): StackSlot | null =>
    isVirtual(operand.register)
      ? locationOf(allocation, node, operand.register).spillSlot
      : null;

  for (const block of fn.blocks) {
    const rewritten: MachineInstruction[] = [];
    for (const node of block.instructions) {
      const operands = registerOperandsOf(node).filter(
        (operand) => spillSlotAt(node, operand) !== null,
      );
      if (operands.length === 0) {
        applyAssignment(allocation, node);
        if (!isRedundantCopy(node)) rewritten.push(node);
        continue;
      }

      const scratchOf = new Map<VirtualRegister, PhysicalRegister>();
      const claim = (role: OperandRole, taken: Map<RegisterClassId, number>): void => {
        for (const operand of operands) {
          const register = operand.register as VirtualRegister;
          if (operand.role !== role || scratchOf.has(register)) continue;
          const index = taken.get(register.classId) ?? 0;
          const scratch = target.registers.classOf(register.classId).scratch[index];
          if (scratch === undefined) {
            throw new OutOfScratchRegistersError(node.opcode, register.classId);
          }
          taken.set(register.classId, index + 1);
          scratchOf.set(register, scratch);
          usedScratch.add(scratch);
        }
      };
      claim("use", new Map<RegisterClassId, number>());
      claim("def", new Map<RegisterClassId, number>());

      const reloaded = new Set<VirtualRegister>();
      const stored = new Map<VirtualRegister, { slot: StackSlot; source: RegisterOperand }>();
      for (const operand of operands) {
        const register = operand.register as VirtualRegister;
        const slot = spillSlotAt(node, operand)!;
        const scratch = scratchOf.get(register)!;
        if (operand.role === "use" && !reloaded.has(register)) {
          reloaded.add(register);
          rewritten.push(lowering.reload(def(scratch, register.width), slot));
        }
        if (operand.role === "def") {
          stored.set(register, { slot, source: use(scratch, register.width) });
        }
        operand.register = scratch;
      }

      applyAssignment(allocation, node);
      rewritten.push(node);
      for (const { slot, source } of stored.values()) {
        rewritten.push(lowering.spill(slot, source));
      }
    }
    block.instructions.length = 0;
    block.instructions.push(...rewritten);
  }
  return [...usedScratch];
}
