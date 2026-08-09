import {
  homeInstruction,
  irConstant,
  type CFGBlock,
  type CFGInstruction,
} from "../ir/index.js";
import { addPhi } from "../ir/cfg-edit.js";

const ACC_SLOT = -1;

type Slot = number;
type CfgNode = CFGInstruction;
type CfgBlock = CFGBlock;
export type RegisterState = Map<Slot, CfgNode | null>;

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

export function definedValue(
  value: CfgNode | null | undefined,
  home: CfgBlock,
): CfgNode {
  if (value) return value;
  return homeInstruction(irConstant(undefined), home);
}

export function addInitialLoopPhis(
  block: CfgBlock,
  predecessor: CfgBlock,
  regs: RegisterState,
  localCount: number,
): Map<Slot, CfgNode> {
  const phis = new Map<Slot, CfgNode>();
  const slots = new Set<Slot>();
  for (let slot = 0; slot < localCount; slot++) slots.add(slot);
  for (const slot of regs.keys()) slots.add(slot);
  for (const slot of [...slots].sort((a, b) => a - b)) {
    const phi = addPhi(block, [definedValue(regs.get(slot), predecessor)]);
    phis.set(slot, phi);
    regs.set(slot, phi);
  }
  return phis;
}

export function addLoopBackedgeInputs(
  block: CfgBlock,
  phis: Map<Slot, CfgNode>,
  statesByTarget: IncomingStatesByTarget,
  target: number,
  predecessor: CfgBlock,
  regs: RegisterState,
): void {
  const states = statesByTarget.get(target) ?? [];
  const byPred = new Map(states.map((state) => [state.predecessor, state]));
  const updateHeaderStates = (slot: Slot, phi: CfgNode): void => {
    for (const group of statesByTarget.values()) {
      for (const state of group) {
        if (state.predecessor === block) state.regs.set(slot, phi);
      }
    }
  };

  for (const slot of regs.keys()) {
    let phi = phis.get(slot);
    if (!phi) {
      const incoming = block.predecessors.map((pred) => {
        const state = byPred.get(pred);
        return definedValue(state?.regs.get(slot), pred);
      });
      if (incoming.length === 0) incoming.push(definedValue(undefined, predecessor));
      phi = addPhi(block, incoming);
      phis.set(slot, phi);
      updateHeaderStates(slot, phi);
    }
    const expectedInputs = block.predecessors.length + 1;
    if (phi.inputs.length < expectedInputs) phi.addInput(regs.get(slot) || phi);
  }
}

export function restoreIncomingState(
  block: CfgBlock,
  states: IncomingState[] | null | undefined,
  regs: RegisterState,
  acc: CfgNode | null | undefined,
): CfgNode | null {
  if (!states || states.length === 0) return acc ?? null;
  if (block.predecessors.length <= 1) {
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
  for (const slot of regs.keys()) slots.add(slot);
  if (acc) slots.add(ACC_SLOT);

  let nextAcc = acc ?? null;

  for (const slot of slots) {
    const incoming = block.predecessors.map((pred) => {
      const state = byPred.get(pred);
      const value = !state
        ? slot === ACC_SLOT
          ? acc
          : regs.get(slot)
        : slot === ACC_SLOT
          ? state.acc
          : state.regs.get(slot);
      return definedValue(value, pred);
    });
    const first = incoming[0];
    const same = incoming.every((value) => value === first);
    const selected: CfgNode = same ? first : addPhi(block, incoming);
    if (slot === ACC_SLOT) {
      nextAcc = selected;
    } else {
      regs.set(slot, selected);
    }
  }

  return nextAcc ?? null;
}
