import {
  isVirtual,
  slotOffsetOf,
  type MachineAddress,
  type MachineFunction,
  type MachineInstruction,
  type MachineOperand,
  type MachineRegister,
} from "./ir.js";

function registerName(register: MachineRegister): string {
  return isVirtual(register) ? `v${register.id}` : `%${register.name}`;
}

function addressText(addr: MachineAddress): string {
  const parts: string[] = [];
  if (addr.symbol !== null) parts.push(addr.symbol);
  const offset = slotOffsetOf(addr);
  if (offset !== 0 || parts.length === 0) parts.push(String(offset));
  const base = addr.base === null ? "" : registerName(addr.base.register);
  const index =
    addr.index === null ? "" : `, ${registerName(addr.index.register)}, ${addr.scale}`;
  return `${parts.join("+")}(${base}${index})`;
}

function operandText(operand: MachineOperand): string {
  if (operand.kind === "register") {
    return `${registerName(operand.register)}:${operand.width}`;
  }
  if (operand.kind === "immediate") return `$${operand.value}`;
  if (operand.kind === "symbol") return operand.name;
  if (operand.kind === "label") return operand.block.label;
  return addressText(operand.address);
}

function instructionText(node: MachineInstruction): string {
  const operands = node.operands.map(operandText).join(", ");
  return operands.length === 0 ? node.opcode : `${node.opcode} ${operands}`;
}

export function printMachineFunction(fn: MachineFunction): string {
  const lines: string[] = [`machine ${fn.symbol}:`];
  for (const block of fn.blocks) {
    const successors = block.successors.map((successor) => successor.label).join(", ");
    lines.push(`${block.label}:${successors.length > 0 ? ` -> ${successors}` : ""}`);
    for (const node of block.instructions) lines.push(`  ${instructionText(node)}`);
  }
  return lines.join("\n");
}
