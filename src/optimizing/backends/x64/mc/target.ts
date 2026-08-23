import { fitsSigned } from "../../../mc/buffer.js";
import { UnsupportedInstructionError, UnsupportedOperandError } from "../../../mc/errors.js";
import { encoded, fixup, type EncodedInstruction } from "../../../mc/fixup.js";
import type { McTarget } from "../../../mc/target.js";
import {
  explicitOperandsOf,
  slotOffsetOf,
  type MachineInstruction,
  type MachineOperand,
  type RegisterOperand,
} from "../../../machine/ir.js";
import { x64FixupModel } from "./fixups.js";
import { x64Padding } from "./padding.js";
import {
  emitImmediate,
  emitModRm,
  emitPrefixes,
  rmRegister,
  sink,
  type EncodeSink,
  type RmOperand,
} from "./encoding.js";
import { opcodeGroup, type BranchForm, type OpcodeForm, type OpcodeGroup } from "./opcodes.js";
import { isFloatRegister, needsRexForByteAccess, x64RegisterNumber } from "./registers.js";

const TARGET = "x64";
const ACCUMULATOR = 0;
const SHIFT_BY_ONE = 1;

function physicalOf(operand: RegisterOperand, opcode: string) {
  if (operand.register.kind !== "physical") {
    throw new UnsupportedOperandError(TARGET, opcode, "virtual register reached encoding");
  }
  return operand.register;
}

function rmOf(operand: MachineOperand, opcode: string): RmOperand {
  if (operand.kind === "register") {
    const register = physicalOf(operand, opcode);
    return rmRegister(
      x64RegisterNumber(register),
      operand.width === 1 && needsRexForByteAccess(register),
    );
  }
  if (operand.kind !== "memory") {
    throw new UnsupportedOperandError(TARGET, opcode, `${operand.kind} is not addressable`);
  }
  const address = operand.address;
  return {
    kind: "memory",
    base: address.base === null ? null : x64RegisterNumber(physicalOf(address.base, opcode)),
    index:
      address.index === null ? null : x64RegisterNumber(physicalOf(address.index, opcode)),
    scale: address.scale,
    displacement: slotOffsetOf(address),
    symbol: address.symbol,
  };
}

function registerNumberOf(operand: MachineOperand, opcode: string): number {
  if (operand.kind !== "register") {
    throw new UnsupportedOperandError(TARGET, opcode, "expected a register operand");
  }
  return x64RegisterNumber(physicalOf(operand, opcode));
}

function signatureOf(operands: readonly MachineOperand[]): string {
  return operands
    .filter((operand) => operand.kind === "register")
    .map((operand) => (operand as RegisterOperand).register.classId)
    .join(",");
}

function emitForm(
  out: EncodeSink,
  form: OpcodeForm,
  reg: number,
  rm: RmOperand,
  opcode: string,
): void {
  emitPrefixes(out, form.mandatory, { wide: form.rexW === true }, reg, rm);
  out.bytes.push(...form.bytes);
  emitModRm(out, reg, rm, opcode);
}

function requireForm(
  group: OpcodeGroup,
  slot: keyof OpcodeGroup,
  opcode: string,
): OpcodeForm {
  const form = group[slot];
  if (form === undefined || Array.isArray(form)) {
    throw new UnsupportedOperandError(TARGET, opcode, `no ${slot} form`);
  }
  return form as OpcodeForm;
}

function branchTargetOf(operands: readonly MachineOperand[]): string | null {
  if (operands.length !== 1) return null;
  const operand = operands[0]!;
  if (operand.kind === "label") return operand.block.label;
  if (operand.kind === "symbol") return operand.name;
  return null;
}

function branchFormsOf(group: OpcodeGroup, operands: readonly MachineOperand[]): number {
  if (group.branch === undefined || branchTargetOf(operands) === null) return 1;
  return group.branch.length;
}

function encodeBranch(
  forms: readonly BranchForm[],
  symbol: string,
  requested: number,
): EncodedInstruction {
  const form = forms[Math.min(requested, forms.length - 1)]!;
  const out = sink();
  out.bytes.push(...form.bytes);
  out.fixups.push(fixup(out.bytes.length, form.fixupKind, symbol, 0));
  for (let index = 0; index < form.displacementBytes; index++) out.bytes.push(0);
  return encoded(out.bytes, out.fixups);
}

function encodeImmediate(
  group: OpcodeGroup,
  destination: MachineOperand,
  value: number | bigint,
  opcode: string,
): EncodedInstruction {
  const out = sink();
  const rm = rmOf(destination, opcode);
  const once = group.m1;
  if (once !== undefined && Number(value) === SHIFT_BY_ONE) {
    emitForm(out, once, once.extension ?? 0, rm, opcode);
    return encoded(out.bytes, out.fixups);
  }
  const short = group.mi8;
  if (short !== undefined && fitsSigned(value, 8)) {
    emitForm(out, short, short.extension ?? 0, rm, opcode);
    emitImmediate(out, value, 1);
    return encoded(out.bytes, out.fixups);
  }
  const accumulator = group.ai;
  if (accumulator !== undefined && rm.kind === "register" && rm.number === ACCUMULATOR) {
    emitPrefixes(out, accumulator.mandatory, { wide: accumulator.rexW === true }, 0, rm);
    out.bytes.push(...accumulator.bytes);
    emitImmediate(out, value, accumulator.immediateBytes ?? 4);
    return encoded(out.bytes, out.fixups);
  }

  const wide = group.oi;
  if (wide !== undefined && rm.kind === "register") {
    emitPrefixes(out, wide.mandatory, { wide: wide.rexW === true }, 0, rm);
    out.bytes.push(wide.bytes[0]! + (rm.number & 7));
    emitImmediate(out, value, wide.immediateBytes ?? 4);
    return encoded(out.bytes, out.fixups);
  }
  const general = requireForm(group, "mi", opcode);
  emitForm(out, general, general.extension ?? 0, rm, opcode);
  emitImmediate(out, value, general.immediateBytes ?? 4);
  return encoded(out.bytes, out.fixups);
}

function encodeBinary(
  group: OpcodeGroup,
  destination: MachineOperand,
  source: MachineOperand,
  opcode: string,
): EncodedInstruction {
  const out = sink();
  if (
    group.mc !== undefined &&
    source.kind === "register" &&
    registerNumberOf(source, opcode) === 1 &&
    source.width === 1
  ) {
    const form = group.mc;
    emitForm(out, form, form.extension ?? 0, rmOf(destination, opcode), opcode);
    return encoded(out.bytes, out.fixups);
  }

  const destinationIsRegister = destination.kind === "register";
  const sourceIsRegister = source.kind === "register";
  const preferStore =
    !destinationIsRegister ||
    (sourceIsRegister &&
      group.mr !== undefined &&
      !isFloatRegister(physicalOf(destination as RegisterOperand, opcode)));

  if (preferStore && group.mr !== undefined) {
    emitForm(
      out,
      group.mr,
      registerNumberOf(source, opcode),
      rmOf(destination, opcode),
      opcode,
    );
    return encoded(out.bytes, out.fixups);
  }

  const form = requireForm(group, "rm", opcode);
  emitForm(out, form, registerNumberOf(destination, opcode), rmOf(source, opcode), opcode);
  return encoded(out.bytes, out.fixups);
}

function encodeInstruction(node: MachineInstruction, form: number): EncodedInstruction {
  const operands = explicitOperandsOf(node, { dropTiedSource: true });
  const group = opcodeGroup(node.opcode, signatureOf(operands));
  if (group === undefined) throw new UnsupportedInstructionError(TARGET, node.opcode);

  const branchTarget = branchTargetOf(operands);
  if (group.branch !== undefined && branchTarget !== null) {
    return encodeBranch(group.branch, branchTarget, form);
  }

  if (operands.length === 0) {
    const none = requireForm(group, "none", node.opcode);
    const out = sink();
    if (none.mandatory !== undefined) out.bytes.push(none.mandatory);
    if (none.rexW === true) out.bytes.push(0x48);
    out.bytes.push(...none.bytes);
    return encoded(out.bytes, out.fixups);
  }

  if (operands.length === 1) {
    const out = sink();
    const rm = rmOf(operands[0]!, node.opcode);
    const short = group.o;
    if (short !== undefined && rm.kind === "register") {
      emitPrefixes(out, short.mandatory, { wide: short.rexW === true }, 0, rm);
      out.bytes.push(short.bytes[0]! + (rm.number & 7));
      return encoded(out.bytes, out.fixups);
    }
    const only = requireForm(group, "m", node.opcode);
    emitForm(out, only, only.extension ?? 0, rm, node.opcode);
    return encoded(out.bytes, out.fixups);
  }

  if (operands.length === 2) {
    const [destination, source] = operands as [MachineOperand, MachineOperand];
    if (source.kind === "immediate") {
      return encodeImmediate(group, destination, source.value, node.opcode);
    }
    return encodeBinary(group, destination, source, node.opcode);
  }

  if (operands.length === 3 && operands[2]!.kind === "immediate") {
    const value = (operands[2] as { value: number | bigint }).value;
    const short = group.rmi8;
    const withImmediate =
      short !== undefined && fitsSigned(value, 8)
        ? short
        : requireForm(group, "rmi", node.opcode);
    const out = sink();
    emitForm(
      out,
      withImmediate,
      registerNumberOf(operands[0]!, node.opcode),
      rmOf(operands[1]!, node.opcode),
      node.opcode,
    );
    emitImmediate(out, value, withImmediate.immediateBytes ?? 4);
    return encoded(out.bytes, out.fixups);
  }

  throw new UnsupportedOperandError(
    TARGET,
    node.opcode,
    `${operands.length} explicit operands`,
  );
}

export const x64McTarget: McTarget = {
  name: TARGET,
  endian: "little",
  pointerWidthBytes: 8,
  functionAlignment: 16,
  fixups: x64FixupModel,
  formsOf: (node) => {
    const operands = explicitOperandsOf(node, { dropTiedSource: true });
    const group = opcodeGroup(node.opcode, signatureOf(operands));
    return group === undefined ? 1 : branchFormsOf(group, operands);
  },
  encode: (node, form) => encodeInstruction(node, form),
  padding: x64Padding,
};
