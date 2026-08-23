import type { MachineInstruction, MachineOperand } from "../../machine/ir.js";
import type { CfiTarget, PrologueEffect } from "../../mc/dwarf/eh-frame.js";

const SLOT_BYTES = 8;
const RETURN_ADDRESS = 1;
const STACK_POINTER = 2;
const STACK_STORES: ReadonlySet<string> = new Set(["sd", "fsd"]);

const counted = (count: number, name: (index: number) => string): string[] =>
  Array.from({ length: count }, (_unused, index) => name(index));

const INTEGER_ORDER: readonly string[] = [
  "zero",
  "ra",
  "sp",
  "gp",
  "tp",
  ...counted(3, (index) => `t${index}`),
  ...counted(2, (index) => `s${index}`),
  ...counted(8, (index) => `a${index}`),
  ...counted(10, (index) => `s${index + 2}`),
  ...counted(4, (index) => `t${index + 3}`),
];

const FLOAT_ORDER: readonly string[] = [
  ...counted(8, (index) => `ft${index}`),
  ...counted(2, (index) => `fs${index}`),
  ...counted(8, (index) => `fa${index}`),
  ...counted(10, (index) => `fs${index + 2}`),
  ...counted(4, (index) => `ft${index + 8}`),
];

const DWARF_REGISTER_NUMBERS: ReadonlyMap<string, number> = new Map(
  [...INTEGER_ORDER, ...FLOAT_ORDER].map((name, number) => [name, number]),
);

export const riscvCfiTarget: CfiTarget = {
  stackPointer: STACK_POINTER,
  returnAddress: RETURN_ADDRESS,
  initialCfaOffset: 0,
  returnAddressAtEntry: null,
  codeAlignment: 1,
  slotBytes: SLOT_BYTES,
  numberOf: (register) => DWARF_REGISTER_NUMBERS.get(register) ?? null,
};

function registerNameOf(operand: MachineOperand | undefined): string | null {
  if (operand === undefined || operand.kind !== "register") return null;
  const register = operand.register;
  return register.kind === "physical" ? register.name : null;
}

function stackDisplacementOf(operand: MachineOperand | undefined): number | null {
  if (operand === undefined || operand.kind !== "memory") return null;
  const address = operand.address;
  if (registerNameOf(address.base ?? undefined) !== "sp" || address.index !== null) return null;
  return address.displacement;
}

function allocationEffect(node: MachineInstruction): PrologueEffect | null {
  if (node.opcode !== "addi") return null;
  const [destination, source, amount] = node.operands;
  if (registerNameOf(destination) !== "sp" || registerNameOf(source) !== "sp") return null;
  if (amount === undefined || amount.kind !== "immediate") return null;
  const bytes = -Number(amount.value);
  if (bytes <= 0 || bytes % SLOT_BYTES !== 0) return null;
  return { kind: "allocate", bytes };
}

function saveEffect(node: MachineInstruction): PrologueEffect | null {
  if (!STACK_STORES.has(node.opcode)) return null;
  const [source, location] = node.operands;
  const displacement = stackDisplacementOf(location);
  const saved = registerNameOf(source);
  if (displacement === null || saved === null || displacement % SLOT_BYTES !== 0) return null;
  if (!DWARF_REGISTER_NUMBERS.has(saved)) return null;
  return { kind: "save", register: saved, offset: displacement };
}

export function prologueEffectOf(node: MachineInstruction): PrologueEffect | null {
  return allocationEffect(node) ?? saveEffect(node);
}
