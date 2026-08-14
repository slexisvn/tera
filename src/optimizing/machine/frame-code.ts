import type { FrameLayout } from "./frame.js";
import type { MachineFunction, MachineInstruction } from "./ir.js";
import type { MachineLowering } from "./lowering.js";

export function insertFrameCode(
  fn: MachineFunction,
  frame: FrameLayout,
  lowering: MachineLowering,
): void {
  const epilogue = lowering.epilogue(frame);
  for (const block of fn.blocks) {
    if (!block.instructions.some((node) => node.flags.returns === true)) continue;
    const rewritten: MachineInstruction[] = [];
    for (const node of block.instructions) {
      if (node.flags.returns === true) rewritten.push(...epilogue);
      rewritten.push(node);
    }
    block.instructions.length = 0;
    block.instructions.push(...rewritten);
  }

  const entry = fn.entry;
  if (entry === null) return;
  entry.instructions.unshift(...lowering.prologue(frame));
}
