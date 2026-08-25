import { solveMonotone, type FlowGraph } from "../infra/dataflow.js";
import { setLattice } from "../infra/lattice.js";
import {
  isVirtual,
  physicalNameOf,
  registerOperandsOf,
  type MachineBlock,
  type MachineFunction,
  type MachineInstruction,
  type MachineOperand,
  type VirtualRegister,
} from "./ir.js";

export type MachineStage = "pre-allocation" | "post-allocation";

export class MachineValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(errors.join("; "));
    this.name = "MachineValidationError";
    this.errors = errors;
  }
}

function at(block: MachineBlock, node: MachineInstruction): string {
  return `${block.label}:${node.opcode}`;
}

function registerName(register: VirtualRegister): string {
  return `v${register.id}`;
}

function validateBlockLinks(fn: MachineFunction, errors: string[]): void {
  const known = new Set(fn.blocks);
  if (fn.entry === null) {
    errors.push("function has no entry block");
  } else if (!known.has(fn.entry)) {
    errors.push(`entry ${fn.entry.label} is not among the function blocks`);
  }
  for (const block of fn.blocks) {
    for (const successor of block.successors) {
      if (!known.has(successor)) {
        errors.push(`${block.label} points at unknown successor ${successor.label}`);
        continue;
      }
      if (!successor.predecessors.includes(block)) {
        errors.push(`${block.label} -> ${successor.label} has no matching predecessor edge`);
      }
    }
    for (const predecessor of block.predecessors) {
      if (!known.has(predecessor)) {
        errors.push(`${block.label} names unknown predecessor ${predecessor.label}`);
        continue;
      }
      if (!predecessor.successors.includes(block)) {
        errors.push(`${predecessor.label} -> ${block.label} has no matching successor edge`);
      }
    }
  }
}

function validateOperands(fn: MachineFunction, errors: string[]): void {
  const slots = new Set(fn.slots);
  const blocks = new Set(fn.blocks);
  const visit = (block: MachineBlock, node: MachineInstruction, operand: MachineOperand): void => {
    if (operand.kind === "label" && !blocks.has(operand.block)) {
      errors.push(`${at(block, node)} branches to unknown block ${operand.block.label}`);
    }
    if (operand.kind === "memory") {
      const slot = operand.address.slot;
      if (slot !== null && !slots.has(slot)) {
        errors.push(`${at(block, node)} addresses stack slot ${slot.id} the frame does not own`);
      }
    }
  };
  for (const block of fn.blocks) {
    for (const node of block.instructions) {
      for (const operand of node.operands) visit(block, node, operand);
      for (const operand of node.operands) {
        if (operand.kind !== "register") continue;
        const register = operand.register;
        if (isVirtual(register) && operand.width > register.width) {
          errors.push(
            `${at(block, node)} uses ${registerName(register)} at ${operand.width} bytes ` +
              `but it only holds ${register.width}`,
          );
        }
      }
    }
  }
}

function validateTiedForm(fn: MachineFunction, stage: MachineStage, errors: string[]): void {
  for (const block of fn.blocks) {
    for (const node of block.instructions) {
      if (node.flags.tied !== true) continue;
      const [destination, source] = node.operands;
      if (
        destination === undefined ||
        destination.kind !== "register" ||
        destination.role !== "def" ||
        source === undefined ||
        source.kind !== "register" ||
        source.role !== "use"
      ) {
        errors.push(`${at(block, node)} is tied but is not in destructive form`);
        continue;
      }
      if (
        stage === "post-allocation" &&
        physicalNameOf(destination) !== physicalNameOf(source)
      ) {
        errors.push(`${at(block, node)} is tied but its operands hold different registers`);
      }
    }
  }
}

function validateNoVirtualsRemain(fn: MachineFunction, errors: string[]): void {
  for (const block of fn.blocks) {
    for (const node of block.instructions) {
      for (const operand of registerOperandsOf(node)) {
        if (isVirtual(operand.register)) {
          errors.push(
            `${at(block, node)} still holds ${registerName(operand.register)} after allocation`,
          );
        }
      }
    }
  }
}

function upwardExposedUses(block: MachineBlock): ReadonlySet<VirtualRegister> {
  const exposed = new Set<VirtualRegister>();
  const defined = new Set<VirtualRegister>();
  for (const node of block.instructions) {
    for (const operand of registerOperandsOf(node)) {
      const register = operand.register;
      if (!isVirtual(register)) continue;
      if (operand.role === "use") {
        if (!defined.has(register)) exposed.add(register);
      } else {
        defined.add(register);
      }
    }
  }
  return exposed;
}

function definedVirtuals(block: MachineBlock): ReadonlySet<VirtualRegister> {
  const defined = new Set<VirtualRegister>();
  for (const node of block.instructions) {
    for (const operand of registerOperandsOf(node)) {
      if (operand.role === "def" && isVirtual(operand.register)) defined.add(operand.register);
    }
  }
  return defined;
}

function validateReachingDefs(fn: MachineFunction, errors: string[]): void {
  const entry = fn.entry;
  if (entry === null) return;
  const exposed = new Map<MachineBlock, ReadonlySet<VirtualRegister>>();
  const killed = new Map<MachineBlock, ReadonlySet<VirtualRegister>>();
  for (const block of fn.blocks) {
    exposed.set(block, upwardExposedUses(block));
    killed.set(block, definedVirtuals(block));
  }
  const graph: FlowGraph<MachineBlock> = {
    nodes: fn.blocks,
    entry,
    successors: (block) => block.successors,
    predecessors: (block) => block.predecessors,
  };
  const live = solveMonotone<MachineBlock, ReadonlySet<VirtualRegister>>(graph, {
    direction: "backward",
    lattice: setLattice<VirtualRegister>(),
    boundary: () => new Set<VirtualRegister>(),
    transfer: (block, out) => {
      const result = new Set(exposed.get(block)!);
      const kill = killed.get(block)!;
      for (const register of out) if (!kill.has(register)) result.add(register);
      return result;
    },
  });
  for (const register of live.stateBefore(entry)) {
    errors.push(`${registerName(register)} is read on a path that never defines it`);
  }
}

export function validateMachineFunction(
  fn: MachineFunction,
  stage: MachineStage,
  after: string,
): true {
  const errors: string[] = [];
  validateBlockLinks(fn, errors);
  validateOperands(fn, errors);
  validateTiedForm(fn, stage, errors);
  if (stage === "post-allocation") validateNoVirtualsRemain(fn, errors);
  else validateReachingDefs(fn, errors);
  if (errors.length > 0) {
    throw new MachineValidationError(
      errors.map((error) => `${fn.symbol} after ${after}: ${error}`),
    );
  }
  return true;
}
