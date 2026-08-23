import {
  copiedRegisters,
  type MachineBlock,
  type MachineFunction,
  type MachineInstruction,
} from "./ir.js";
import type { MachineLowering } from "./lowering.js";

function jumpTarget(node: MachineInstruction, unconditional: string): MachineBlock | null {
  if (node.opcode !== unconditional || node.operands.length !== 1) return null;
  const only = node.operands[0]!;
  return only.kind === "label" ? only.block : null;
}

function copiesItself(node: MachineInstruction): boolean {
  const copied = copiedRegisters(node);
  return copied !== null && copied.into === copied.from;
}

function dropSelfCopies(block: MachineBlock): number {
  const kept = block.instructions.filter((node) => !copiesItself(node));
  const removed = block.instructions.length - kept.length;
  if (removed > 0) block.instructions.splice(0, block.instructions.length, ...kept);
  return removed;
}

function fallThrough(
  block: MachineBlock,
  next: MachineBlock | undefined,
  lowering: MachineLowering,
  unconditional: string,
): number {
  const instructions = block.instructions;
  const last = instructions[instructions.length - 1];
  if (last === undefined || next === undefined) return 0;
  const jumped = jumpTarget(last, unconditional);
  if (jumped === next) {
    instructions.pop();
    return 1;
  }
  const taken = instructions[instructions.length - 2];
  if (jumped === null || taken === undefined || jumpTarget(taken, unconditional) !== null) {
    return 0;
  }
  const inverted = lowering.invertBranch(taken, jumped);
  if (inverted === null || labelledBlock(taken) !== next) return 0;
  instructions.splice(instructions.length - 2, 2, inverted);
  return 1;
}

function labelledBlock(node: MachineInstruction): MachineBlock | null {
  const named = node.operands[node.operands.length - 1];
  return named !== undefined && named.kind === "label" ? named.block : null;
}

export function peepholeMachineCode(fn: MachineFunction, lowering: MachineLowering): number {
  const first = fn.blocks[0];
  if (first === undefined) return 0;
  const unconditional = lowering.jump(first).opcode;
  let removed = 0;
  fn.blocks.forEach((block, position) => {
    removed += fallThrough(block, fn.blocks[position + 1], lowering, unconditional);
    removed += dropSelfCopies(block);
  });
  return removed;
}
