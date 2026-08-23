import {
  definedOperandsOf,
  physicalNameOf,
  usedOperandsOf,
  type MachineBlock,
  type MachineFunction,
  type MachineInstruction,
  type RegisterOperand,
} from "./ir.js";
import type { CallingConvention } from "../target/abi.js";

export interface PhysicalLiveness {
  liveAfter(block: MachineBlock, at: number, register: string): boolean;
}

const EVERYTHING = "*";

function namesOf(operands: readonly RegisterOperand[]): string[] {
  return operands.flatMap((operand) => {
    const name = physicalNameOf(operand);
    return name === null ? [] : [name];
  });
}

function stepBackwards(
  node: MachineInstruction,
  live: Set<string>,
  answered: ReadonlySet<string>,
): void {
  if (node.flags.call === true) {
    live.add(EVERYTHING);
    return;
  }
  if (node.flags.returns === true) {
    for (const name of answered) live.add(name);
    return;
  }
  for (const name of namesOf(definedOperandsOf(node))) live.delete(name);
  for (const name of namesOf(usedOperandsOf(node))) live.add(name);
}

function sameNames(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const name of left) {
    if (!right.has(name)) return false;
  }
  return true;
}

function liveOutOf(
  block: MachineBlock,
  liveIn: ReadonlyMap<MachineBlock, ReadonlySet<string>>,
  answered: ReadonlySet<string>,
): Set<string> {
  if (block.successors.length === 0) return new Set(answered);
  const live = new Set<string>();
  for (const successor of block.successors) {
    for (const name of liveIn.get(successor) ?? []) live.add(name);
  }
  return live;
}

export function physicalLiveness(
  fn: MachineFunction,
  convention: CallingConvention,
): PhysicalLiveness {
  const answered = new Set(
    [...convention.returnRegisters.values()].map((register) => register.name),
  );
  const liveIn = new Map<MachineBlock, ReadonlySet<string>>();
  for (let round = 0; round <= fn.blocks.length; round++) {
    let widened = false;
    for (let at = fn.blocks.length - 1; at >= 0; at--) {
      const block = fn.blocks[at]!;
      const live = liveOutOf(block, liveIn, answered);
      for (let index = block.instructions.length - 1; index >= 0; index--) {
        stepBackwards(block.instructions[index]!, live, answered);
      }
      const known = liveIn.get(block);
      if (known !== undefined && sameNames(known, live)) continue;
      liveIn.set(block, live);
      widened = true;
    }
    if (!widened) break;
  }

  const after = new Map<MachineBlock, ReadonlySet<string>[]>();
  for (const block of fn.blocks) {
    const live = liveOutOf(block, liveIn, answered);
    const columns: ReadonlySet<string>[] = new Array(block.instructions.length);
    for (let index = block.instructions.length - 1; index >= 0; index--) {
      columns[index] = new Set(live);
      stepBackwards(block.instructions[index]!, live, answered);
    }
    after.set(block, columns);
  }

  return {
    liveAfter(block, at, register) {
      const live = after.get(block)?.[at];
      if (live === undefined) return true;
      return live.has(register) || live.has(EVERYTHING);
    },
  };
}
