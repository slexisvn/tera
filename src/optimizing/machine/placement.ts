import type { MachineBlock, MachineFunction } from "./ir.js";

interface BackEdge {
  readonly header: MachineBlock;
  readonly latch: MachineBlock;
  readonly depth: number;
}

function backEdgesOf(fn: MachineFunction): BackEdge[] {
  const position = new Map<MachineBlock, number>();
  fn.blocks.forEach((block, at) => position.set(block, at));
  const found: BackEdge[] = [];
  for (const latch of fn.blocks) {
    for (const header of latch.successors) {
      const from = position.get(latch)!;
      const to = position.get(header)!;
      if (to > from) continue;
      found.push({ header, latch, depth: to });
    }
  }
  return found.sort((left, right) => right.depth - left.depth);
}

export function placeLoopHeadersAfterBodies(fn: MachineFunction): number {
  const entry = fn.blocks[0];
  let moved = 0;
  for (const { header, latch } of backEdgesOf(fn)) {
    if (header === entry || header === latch) continue;
    const from = fn.blocks.indexOf(header);
    const to = fn.blocks.indexOf(latch);
    if (from < 0 || to < 0 || from >= to) continue;
    fn.blocks.splice(from, 1);
    fn.blocks.splice(fn.blocks.indexOf(latch) + 1, 0, header);
    moved++;
  }
  return moved;
}
