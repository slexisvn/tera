import {
  copiedRegisters,
  definedOperandsOf,
  physicalNameOf,
  registerOperandsOf,
  usedOperandsOf,
  type MachineBlock,
  type MachineFunction,
  type MachineInstruction,
  type MachineOperand,
  type RegisterOperand,
} from "./ir.js";
import { physicalLiveness, type PhysicalLiveness } from "./physical-liveness.js";
import type { CallingConvention } from "../target/abi.js";

function touches(node: MachineInstruction, register: string): boolean {
  if (node.flags.call === true) return true;
  return registerOperandsOf(node).some((operand) => physicalNameOf(operand) === register);
}

function readsThroughMemory(node: MachineInstruction, register: string): boolean {
  return node.operands.some(
    (operand) =>
      operand.kind === "memory" &&
      [operand.address.base, operand.address.index].some(
        (part) => part !== null && physicalNameOf(part) === register,
      ),
  );
}

function renamed(operand: MachineOperand, scratch: string, held: string): MachineOperand {
  if (operand.kind !== "register" || physicalNameOf(operand) !== scratch) return operand;
  return { ...operand, register: { ...operand.register, name: held } } as MachineOperand;
}

function worksOnScratch(node: MachineInstruction, scratch: string, held: string): boolean {
  if (node.flags.tied !== true || node.flags.call === true) return false;
  if (physicalNameOf(node.operands[0]) !== scratch) return false;
  if (readsThroughMemory(node, scratch) || readsThroughMemory(node, held)) return false;
  return !touches(node, held);
}

function closingIndex(
  block: MachineBlock,
  from: number,
  scratch: string,
  held: string,
): number {
  for (let at = from; at < block.instructions.length; at++) {
    const node = block.instructions[at]!;
    const closing = copiedRegisters(node);
    if (closing !== null && closing.into === held && closing.from === scratch) return at;
    if (touches(node, scratch) || touches(node, held)) return -1;
  }
  return -1;
}

function definesOnly(node: MachineInstruction): RegisterOperand | null {
  if (node.flags.call === true || node.flags.tied === true) return null;
  const written = definedOperandsOf(node);
  if (written.length !== 1 || physicalNameOf(written[0]) === null) return null;
  const scratch = physicalNameOf(written[0])!;
  const reads = usedOperandsOf(node).some((operand) => physicalNameOf(operand) === scratch);
  return reads || readsThroughMemory(node, scratch) ? null : written[0]!;
}

function foldDefineThenCopy(block: MachineBlock, liveness: PhysicalLiveness): boolean {
  for (let at = 0; at + 1 < block.instructions.length; at++) {
    const worker = block.instructions[at]!;
    const written = definesOnly(worker);
    if (written === null) continue;
    const scratch = physicalNameOf(written)!;
    for (let next = at + 1; next < block.instructions.length; next++) {
      const node = block.instructions[next]!;
      const copied = copiedRegisters(node);
      if (copied === null || copied.from !== scratch || copied.into === scratch) {
        if (touches(node, scratch)) break;
        continue;
      }
      const held = copied.into;
      const blocked = block.instructions
        .slice(at + 1, next)
        .some((between) => touches(between, held));
      if (blocked) break;
      if (node.operands[0]!.kind !== "register" || written.width !== node.operands[0].width) break;
      if (liveness.liveAfter(block, next, scratch)) break;

      worker.operands.forEach((operand, index) => {
        worker.operands[index] = renamed(operand, scratch, held);
      });
      block.instructions.splice(next, 1);
      return true;
    }
  }
  return false;
}

function coalesceOnce(block: MachineBlock, liveness: PhysicalLiveness): boolean {
  for (let at = 0; at + 2 < block.instructions.length; at++) {
    const opening = copiedRegisters(block.instructions[at]);
    const worker = block.instructions[at + 1]!;
    if (opening === null || opening.into === opening.from) continue;
    if (!worksOnScratch(worker, opening.into, opening.from)) continue;
    const closing = closingIndex(block, at + 2, opening.into, opening.from);
    if (closing < 0 || liveness.liveAfter(block, closing, opening.into)) continue;

    worker.operands.forEach((operand, index) => {
      worker.operands[index] = renamed(operand, opening.into, opening.from);
    });
    block.instructions.splice(closing, 1);
    block.instructions.splice(at, 1);
    return true;
  }
  return false;
}

export function coalesceRoundTrips(
  fn: MachineFunction,
  convention: CallingConvention,
): number {
  let removed = 0;
  for (;;) {
    const liveness = physicalLiveness(fn, convention);
    const roundTrip = fn.blocks.some((block) => coalesceOnce(block, liveness));
    if (roundTrip) {
      removed += 2;
      continue;
    }
    if (!fn.blocks.some((block) => foldDefineThenCopy(block, liveness))) break;
    removed += 1;
  }
  return removed;
}
