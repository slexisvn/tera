import { CFGInstruction, IR_BRANCH, IR_JUMP, IR_PHI, type CFGBlock } from "./index.js";
import { detachInputs } from "./graph-edit.js";

export function link(pred: CFGBlock, succ: CFGBlock): void {
  if (!pred.successors.includes(succ)) pred.successors.push(succ);
  if (!succ.predecessors.includes(pred)) succ.predecessors.push(pred);
}

export function addPhi(
  block: CFGBlock,
  inputs: readonly CFGInstruction[] = [],
): CFGInstruction {
  const phi = new CFGInstruction(IR_PHI, { index: block.phis.length });
  for (const input of inputs) phi.addInput(input);
  phi.block = block;
  block.phis.push(phi);
  block.nodes.splice(block.phis.length - 1, 0, phi);
  return phi;
}

export function connect(
  pred: CFGBlock,
  succ: CFGBlock,
  phiArgs: readonly CFGInstruction[] = [],
): void {
  link(pred, succ);
  for (let i = 0; i < succ.phis.length; i++) succ.phis[i].addInput(phiArgs[i]);
}

export function predecessorIndex(succ: CFGBlock, pred: CFGBlock): number {
  return succ.predecessors.indexOf(pred);
}

export function phiInputFor(
  phi: CFGInstruction,
  pred: CFGBlock,
): CFGInstruction | undefined {
  const block = phi.block;
  if (!block) return undefined;
  const index = block.predecessors.indexOf(pred);
  return index < 0 ? undefined : phi.inputs[index];
}

export function disconnectAt(succ: CFGBlock, index: number): void {
  const pred = succ.predecessors[index];
  if (!pred) return;
  succ.predecessors.splice(index, 1);
  for (const phi of succ.phis) {
    const removed = phi.inputs[index];
    phi.inputs.splice(index, 1);
    if (removed) removed.uses = removed.uses.filter((use) => use !== phi);
  }
  pred.successors = pred.successors.filter((block) => block !== succ);
}

export function disconnect(pred: CFGBlock, succ: CFGBlock): void {
  const index = succ.predecessors.indexOf(pred);
  if (index >= 0) disconnectAt(succ, index);
}

export function rewriteBranchAsJump(
  block: CFGBlock,
  taken: CFGBlock,
  dead: CFGBlock,
): boolean {
  const terminator = block.getTerminator();
  if (!terminator || terminator.type !== IR_BRANCH) return false;
  detachInputs(terminator);
  terminator.type = IR_JUMP;
  terminator.props = { targetBlock: taken.id };
  if (dead !== taken) disconnect(block, dead);
  return true;
}

export function removePhi(block: CFGBlock, phi: CFGInstruction): void {
  for (const input of phi.inputs) {
    if (input) input.uses = input.uses.filter((use) => use !== phi);
  }
  phi.inputs = [];
  block.phis = block.phis.filter((candidate) => candidate !== phi);
  block.nodes = block.nodes.filter((candidate) => candidate !== phi);
  for (let i = 0; i < block.phis.length; i++) block.phis[i].props.index = i;
  phi.block = null;
}
