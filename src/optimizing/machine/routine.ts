import type { RegisterFile } from "../target/registers.js";
import type { MachineDataItem } from "./data.js";
import type { MachineDatum } from "./ir.js";
import {
  def,
  label,
  sym,
  use,
  MachineFunction,
  instruction,
  type InstructionFlags,
  type MachineBlock,
  type MachineOperand,
  type MemoryOperand,
  type RegisterOperand,
} from "./ir.js";

export const ROUTINE_ENTRY = "entry";

export class MachineRoutineBuilder {
  private readonly fn: MachineFunction;
  private readonly named = new Map<string, MachineBlock>();
  private current: MachineBlock;

  constructor(
    readonly symbol: string,
    private readonly registers: RegisterFile,
  ) {
    this.fn = new MachineFunction(symbol, symbol);
    this.current = this.blockFor(ROUTINE_ENTRY);
  }

  private blockFor(name: string): MachineBlock {
    const existing = this.named.get(name);
    if (existing !== undefined) return existing;
    const created = this.fn.createBlock(`.L${this.symbol}_${name}`);
    this.named.set(name, created);
    return created;
  }

  at(name: string): this {
    const block = this.blockFor(name);
    const position = this.fn.blocks.indexOf(block);
    if (position >= 0) this.fn.blocks.splice(position, 1);
    this.fn.blocks.push(block);
    this.current = block;
    return this;
  }

  read(name: string, width: number): RegisterOperand {
    return use(this.registers.register(name), width);
  }

  write(name: string, width: number): RegisterOperand {
    return def(this.registers.register(name), width);
  }

  emit(opcode: string, ...operands: MachineOperand[]): this {
    this.current.instructions.push(instruction(opcode, operands));
    return this;
  }

  flagged(opcode: string, flags: InstructionFlags, ...operands: MachineOperand[]): this {
    this.current.instructions.push(instruction(opcode, operands, flags));
    return this;
  }

  to(opcode: string, target: string, ...operands: MachineOperand[]): this {
    this.current.instructions.push(
      instruction(opcode, [...operands, label(this.blockFor(target))], {
        terminator: true,
      }),
    );
    return this;
  }

  data(
    key: string,
    alignment: number,
    items: readonly MachineDataItem[],
    writable = false,
  ): MachineDatum {
    return this.fn.data.intern(key, alignment, items, ".LR", writable);
  }

  callSymbol(symbol: string): this {
    this.fn.externals.add(symbol);
    this.current.instructions.push(
      instruction("call", [sym(symbol)], { call: true, implicitFrom: 1 }),
    );
    return this;
  }

  callThrough(address: MemoryOperand): this {
    this.current.instructions.push(
      instruction("call", [address], { call: true, implicitFrom: 1 }),
    );
    return this;
  }

  ret(): this {
    this.current.instructions.push(instruction("ret", [], { terminator: true }));
    return this;
  }

  build(): MachineFunction {
    return this.fn;
  }
}

export function routine(
  symbol: string,
  registers: RegisterFile,
  define: (builder: MachineRoutineBuilder) => void,
): MachineFunction {
  const builder = new MachineRoutineBuilder(symbol, registers);
  define(builder);
  return builder.build();
}
