import type { PhysicalRegister, RegisterClassId } from "../target/registers.js";

export interface VirtualRegister {
  readonly kind: "virtual";
  readonly id: number;
  readonly classId: RegisterClassId;
  readonly width: number;
}

export type MachineRegister = VirtualRegister | PhysicalRegister;

export type StackSlotKind = "local" | "incoming";

export interface StackSlot {
  readonly id: number;
  readonly kind: StackSlotKind;
  readonly size: number;
  readonly alignment: number;
  offset: number;
}

export type OperandRole = "def" | "use";

export interface RegisterOperand {
  readonly kind: "register";
  readonly role: OperandRole;
  readonly width: number;
  register: MachineRegister;
}

export interface ImmediateOperand {
  readonly kind: "immediate";
  readonly value: number;
}

export interface SymbolOperand {
  readonly kind: "symbol";
  readonly name: string;
}

export interface LabelOperand {
  readonly kind: "label";
  readonly block: MachineBlock;
}

export interface MachineAddress {
  readonly base: RegisterOperand | null;
  readonly index: RegisterOperand | null;
  readonly scale: number;
  readonly displacement: number;
  readonly slot: StackSlot | null;
  readonly symbol: string | null;
}

export interface MemoryOperand {
  readonly kind: "memory";
  readonly width: number;
  readonly address: MachineAddress;
}

export type MachineOperand =
  | RegisterOperand
  | ImmediateOperand
  | SymbolOperand
  | LabelOperand
  | MemoryOperand;

export interface InstructionFlags {
  readonly terminator?: boolean;
  readonly call?: boolean;
  readonly copy?: boolean;
  readonly tied?: boolean;
  readonly implicitFrom?: number;
}

export class MachineInstruction {
  position = -1;

  constructor(
    readonly opcode: string,
    readonly operands: MachineOperand[],
    readonly flags: InstructionFlags = {},
  ) {}
}

export class MachineBlock {
  readonly instructions: MachineInstruction[] = [];
  readonly predecessors: MachineBlock[] = [];
  readonly successors: MachineBlock[] = [];
  from = 0;
  to = 0;

  constructor(
    readonly id: number,
    readonly label: string,
  ) {}
}

export interface MachineDatum {
  readonly label: string;
  readonly alignment: number;
  readonly directives: readonly string[];
}

export class MachineDataPool {
  private readonly byKey = new Map<string, MachineDatum>();
  private sequence = 0;

  intern(
    key: string,
    alignment: number,
    directives: (label: string) => readonly string[],
    prefix = ".LC",
  ): MachineDatum {
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const label = `${prefix}${this.sequence++}`;
    const datum: MachineDatum = { label, alignment, directives: directives(label) };
    this.byKey.set(key, datum);
    return datum;
  }

  get items(): readonly MachineDatum[] {
    return [...this.byKey.values()];
  }
}

export class MachineFunction {
  readonly blocks: MachineBlock[] = [];
  readonly slots: StackSlot[] = [];
  readonly data = new MachineDataPool();
  readonly references = new Set<string>();
  readonly externals = new Set<string>();
  entry: MachineBlock | null = null;
  outgoingBytes = 0;
  hasCalls = false;
  private nextBlockId = 0;
  private nextVirtualId = 0;
  private nextSlotId = 0;

  constructor(
    readonly name: string,
    readonly symbol: string,
  ) {}

  createBlock(label: string): MachineBlock {
    const block = new MachineBlock(this.nextBlockId++, label);
    this.blocks.push(block);
    if (this.entry === null) this.entry = block;
    return block;
  }

  insertAfter(anchor: MachineBlock, block: MachineBlock): void {
    const index = this.blocks.indexOf(block);
    if (index >= 0) this.blocks.splice(index, 1);
    this.blocks.splice(this.blocks.indexOf(anchor) + 1, 0, block);
  }

  createVirtual(classId: RegisterClassId, width: number): VirtualRegister {
    return { kind: "virtual", id: this.nextVirtualId++, classId, width };
  }

  createSlot(size: number, alignment: number): StackSlot {
    const slot: StackSlot = {
      id: this.nextSlotId++,
      kind: "local",
      size,
      alignment,
      offset: 0,
    };
    this.slots.push(slot);
    return slot;
  }

  createIncomingSlot(abiOffset: number, size: number): StackSlot {
    const slot: StackSlot = {
      id: this.nextSlotId++,
      kind: "incoming",
      size,
      alignment: size,
      offset: abiOffset,
    };
    this.slots.push(slot);
    return slot;
  }

  get virtualCount(): number {
    return this.nextVirtualId;
  }
}

export function def(register: MachineRegister, width: number): RegisterOperand {
  return { kind: "register", role: "def", width, register };
}

export function use(register: MachineRegister, width: number): RegisterOperand {
  return { kind: "register", role: "use", width, register };
}

export function imm(value: number): ImmediateOperand {
  return { kind: "immediate", value };
}

export function sym(name: string): SymbolOperand {
  return { kind: "symbol", name };
}

export function label(block: MachineBlock): LabelOperand {
  return { kind: "label", block };
}

export function address(parts: Partial<MachineAddress>): MachineAddress {
  return {
    base: parts.base ?? null,
    index: parts.index ?? null,
    scale: parts.scale ?? 1,
    displacement: parts.displacement ?? 0,
    slot: parts.slot ?? null,
    symbol: parts.symbol ?? null,
  };
}

export function mem(width: number, parts: Partial<MachineAddress>): MemoryOperand {
  return { kind: "memory", width, address: address(parts) };
}

export function instruction(
  opcode: string,
  operands: MachineOperand[],
  flags: InstructionFlags = {},
): MachineInstruction {
  return new MachineInstruction(opcode, operands, flags);
}

export function registerOperandsOf(node: MachineInstruction): RegisterOperand[] {
  const found: RegisterOperand[] = [];
  for (const operand of node.operands) {
    if (operand.kind === "register") found.push(operand);
    else if (operand.kind === "memory") {
      if (operand.address.base !== null) found.push(operand.address.base);
      if (operand.address.index !== null) found.push(operand.address.index);
    }
  }
  return found;
}

export function definedOperandsOf(node: MachineInstruction): RegisterOperand[] {
  return registerOperandsOf(node).filter((operand) => operand.role === "def");
}

export function usedOperandsOf(node: MachineInstruction): RegisterOperand[] {
  return registerOperandsOf(node).filter((operand) => operand.role === "use");
}

export function isVirtual(register: MachineRegister): register is VirtualRegister {
  return register.kind === "virtual";
}

export function isPhysical(register: MachineRegister): register is PhysicalRegister {
  return register.kind === "physical";
}

export function slotOffsetOf(addr: MachineAddress): number {
  return addr.displacement + (addr.slot === null ? 0 : addr.slot.offset);
}
