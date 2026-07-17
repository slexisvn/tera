import { irConstant, type CFGBlock, type CFGInstruction } from "../ir/index.js";

const ACC_SLOT = -1;

type Slot = number;
type CfgNode = CFGInstruction;
type CfgBlock = CFGBlock;
type RegisterState = Map<Slot, CfgNode | null>;

interface IncomingState {
  predecessor: CfgBlock;
  regs: RegisterState;
  acc: CfgNode | null | undefined;
}

export type IncomingStatesByTarget = Map<number, IncomingState[]>;

export function rememberIncomingState(
  states: IncomingStatesByTarget,
  target: number,
  predecessor: CfgBlock,
  regs: RegisterState,
  acc: CfgNode | null | undefined,
): void {
  if (!states.has(target)) states.set(target, []);
  states.get(target)!.push({ predecessor, regs: new Map(regs), acc });
}

function definedValue(value: CfgNode | null | undefined): CfgNode {
  return value || irConstant(undefined);
}

export function restoreIncomingState(
  block: CfgBlock,
  states: IncomingState[] | null | undefined,
  regs: RegisterState,
  acc: CfgNode | null | undefined,
): CfgNode | null {
  if (!states || states.length === 0) return acc ?? null;
  if (states.length === 1 || block.predecessors.length <= 1) {
    const state = states[0];
    for (const [slot, value] of state.regs) regs.set(slot, value ?? null);
    return state.acc ?? acc ?? null;
  }

  const byPred = new Map(states.map((state) => [state.predecessor, state]));
  const slots = new Set<Slot>();
  for (const state of states) {
    for (const slot of state.regs.keys()) slots.add(slot);
    if (state.acc) slots.add(ACC_SLOT);
  }

  const edgeArgs = new Map<CfgBlock, CfgNode[]>(
    block.predecessors.map((pred) => [pred, []]),
  );
  let nextAcc = acc ?? null;

  for (const slot of slots) {
    const values = block.predecessors.map((pred) => {
      const state = byPred.get(pred);
      if (!state) return slot === ACC_SLOT ? acc : regs.get(slot);
      return slot === ACC_SLOT ? state.acc : state.regs.get(slot);
    });
    const incoming: CFGInstruction[] = values.map(definedValue);
    const first = incoming[0];
    const same = incoming.every((value) => value === first);
    const selected: CfgNode = same ? first : block.addParam(incoming);
    if (!same) {
      for (let i = 0; i < block.predecessors.length; i++) {
        edgeArgs.get(block.predecessors[i])!.push(incoming[i]!);
      }
    }
    if (slot === ACC_SLOT) {
      nextAcc = selected;
    } else {
      regs.set(slot, selected);
    }
  }

  for (const pred of block.predecessors) {
    if (pred.successors.includes(block))
      pred.setEdgeArgs(block, edgeArgs.get(pred)!);
  }

  return nextAcc ?? null;
}
