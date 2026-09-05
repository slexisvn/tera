import type { FrameLayout } from "./frame.js";
import type { MachineFunction, MachineInstruction } from "./ir.js";
import type { MachineLowering } from "./lowering.js";

function calledSymbolsOf(nodes: readonly MachineInstruction[]): string[] {
  const symbols: string[] = [];
  for (const node of nodes) {
    if (node.flags.call !== true) continue;
    for (const operand of node.operands) {
      if (operand.kind === "symbol") symbols.push(operand.name);
    }
  }
  return symbols;
}

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
  const prologue = lowering.prologue(frame);
  for (const symbol of calledSymbolsOf(prologue)) fn.externals.add(symbol);
  entry.instructions.unshift(...prologue);
}
