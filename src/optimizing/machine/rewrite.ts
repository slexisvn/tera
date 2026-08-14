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

function applyAssignment(
  node: MachineInstruction,
  assignment: ReadonlyMap<VirtualRegister, PhysicalRegister>,
): void {
  for (const operand of registerOperandsOf(node)) {
    if (!isVirtual(operand.register)) continue;
    const physical = assignment.get(operand.register);
    if (physical === undefined) {
      throw new Error(`v${operand.register.id} survived allocation without a register`);
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
  const usedScratch = new Set<PhysicalRegister>();
  const assignment = new Map<VirtualRegister, PhysicalRegister>();
  const slots = new Map<VirtualRegister, StackSlot>();
  for (const interval of allocation.intervals) {
    const register = interval.register;
    if (!isVirtual(register)) continue;
    if (interval.assigned !== null) assignment.set(register, interval.assigned);
    else slots.set(register, interval.spillSlot!);
  }

  for (const block of fn.blocks) {
    const rewritten: MachineInstruction[] = [];
    for (const node of block.instructions) {
      const operands = registerOperandsOf(node).filter(
        (operand) => isVirtual(operand.register) && slots.has(operand.register),
      );
      if (operands.length === 0) {
        applyAssignment(node, assignment);
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
      const stored = new Map<VirtualRegister, RegisterOperand>();
      for (const operand of operands) {
        const register = operand.register as VirtualRegister;
        const scratch = scratchOf.get(register)!;
        if (operand.role === "use" && !reloaded.has(register)) {
          reloaded.add(register);
          rewritten.push(
            lowering.reload(def(scratch, register.width), slots.get(register)!),
          );
        }
        if (operand.role === "def") stored.set(register, use(scratch, register.width));
        operand.register = scratch;
      }

      applyAssignment(node, assignment);
      rewritten.push(node);
      for (const [register, source] of stored) {
        rewritten.push(lowering.spill(slots.get(register)!, source));
      }
    }
    block.instructions.length = 0;
    block.instructions.push(...rewritten);
  }
  return [...usedScratch];
}
