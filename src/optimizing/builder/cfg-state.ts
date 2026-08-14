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
  let group = states.get(target);
  if (!group) {
    group = [];
    states.set(target, group);
  }
  group.push({ predecessor, regs: new Map(regs), acc });
}

export function definedValue(
  value: CfgNode | null | undefined,
  home: CfgBlock,
): CfgNode {
  if (value) return value;
  return homeInstruction(irConstant(undefined), home);
}

function indexByPredecessor(
  states: readonly IncomingState[],
): Map<CfgBlock, IncomingState> {
  return new Map(states.map((state) => [state.predecessor, state]));
}

function stateValue(
  state: IncomingState | undefined,
  slot: Slot,
): CfgNode | null | undefined {
  if (!state) return undefined;
  return slot === ACC_SLOT ? state.acc : state.regs.get(slot);
}

function incomingValues(
  block: CfgBlock,
  byPredecessor: Map<CfgBlock, IncomingState>,
  slot: Slot,
  fallbackHome: CfgBlock,
): CfgNode[] {
  if (block.predecessors.length === 0) {
    return [definedValue(undefined, fallbackHome)];
  }
  return block.predecessors.map((predecessor) =>
    definedValue(stateValue(byPredecessor.get(predecessor), slot), predecessor),
  );
}

function liveSlots(
  states: readonly IncomingState[],
  seed: Iterable<Slot>,
): Slot[] {
  const slots = new Set<Slot>(seed);
  for (const state of states) {
    for (const slot of state.regs.keys()) slots.add(slot);
    if (state.acc) slots.add(ACC_SLOT);
  }
  return [...slots].sort((a, b) => a - b);
}

function range(count: number): Slot[] {
  return Array.from({ length: count }, (_slot, index) => index);
}

export function openLoopHeader(
  block: CfgBlock,
  states: readonly IncomingState[],
  regs: RegisterState,
  localCount: number,
  entryHome: CfgBlock,
): Map<Slot, CfgNode> {
  const byPredecessor = indexByPredecessor(states);
  const slots = liveSlots(states, range(localCount)).filter(
    (slot) => slot !== ACC_SLOT,
  );
  const phis = new Map<Slot, CfgNode>();
  regs.clear();
  for (const slot of slots) {
    const phi = addPhi(
      block,
      incomingValues(block, byPredecessor, slot, entryHome),
    );
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
  const byPredecessor = indexByPredecessor(statesByTarget.get(target) ?? []);
  const expectedInputs = block.predecessors.length + 1;
  const republish = (slot: Slot, phi: CfgNode): void => {
    for (const group of statesByTarget.values()) {
      for (const state of group) {
        if (state.predecessor === block) state.regs.set(slot, phi);
      }
    }
  };

  for (const slot of regs.keys()) {
    let phi = phis.get(slot);
    if (!phi) {
      phi = addPhi(
        block,
        incomingValues(block, byPredecessor, slot, predecessor),
      );
      phis.set(slot, phi);
      republish(slot, phi);
    }
    if (phi.inputs.length < expectedInputs) phi.addInput(regs.get(slot) || phi);
  }
  for (const [slot, phi] of phis) {
    if (regs.has(slot)) continue;
    if (phi.inputs.length < expectedInputs) phi.addInput(phi);
  }
}

export function mergeIncomingState(
  block: CfgBlock,
  states: readonly IncomingState[],
  regs: RegisterState,
  acc: CfgNode | null | undefined,
): CfgNode | null {
  if (states.length === 0) return acc ?? null;

  const byPredecessor = indexByPredecessor(states);
  const slots = liveSlots(states, []);
  let nextAcc: CfgNode | null = null;
  regs.clear();

  for (const slot of slots) {
    const incoming = incomingValues(block, byPredecessor, slot, block);
    const first = incoming[0];
    const uniform = incoming.every((value) => value === first);
    const selected = uniform ? first : addPhi(block, incoming);
    if (slot === ACC_SLOT) nextAcc = selected;
    else regs.set(slot, selected);
  }

  return nextAcc;
}
