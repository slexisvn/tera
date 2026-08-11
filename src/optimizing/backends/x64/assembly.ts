import type { MachineDatum, MachineFunction, MachineInstruction, MachineOperand } from "../../machine/ir.js";
import { slotOffsetOf } from "../../machine/ir.js";
import { machineDataText } from "../../machine/data.js";
import type { FrameLayout } from "../../machine/frame.js";
import { X64_FPR } from "./registers.js";
import { x64RegisterName } from "./registers.js";
import type { ObjectFormat } from "./format.js";
import type { X64TargetModel } from "./target.js";

const ADDRESS_WIDTH = 8;

export class X64AssemblyWriter {
  private frame: FrameLayout = { outgoingBytes: 0, localBytes: 0, frameSize: 0, saved: [] };

  constructor(private readonly target: X64TargetModel) {}

  private get format(): ObjectFormat {
    return this.target.objectFormat;
  }

  private registerText(operand: MachineOperand, width: number): string {
    if (operand.kind !== "register") throw new Error("expected a register operand");
    if (operand.register.kind !== "physical") {
      throw new Error("virtual register survived to assembly emission");
    }
    return `%${x64RegisterName(operand.register, width)}`;
  }

  private operandText(operand: MachineOperand): string {
    if (operand.kind === "register") return this.registerText(operand, operand.width);
    if (operand.kind === "immediate") return `$${operand.value}`;
    if (operand.kind === "symbol") return this.symbolText(operand.name);
    if (operand.kind === "label") return operand.block.label;
    const addr = operand.address;
    if (addr.symbol !== null) return `${addr.symbol}(%rip)`;
    const base = addr.base === null ? "" : this.registerText(addr.base, ADDRESS_WIDTH);
    const index =
      addr.index === null
        ? ""
        : `,${this.registerText(addr.index, ADDRESS_WIDTH)},${addr.scale}`;
    return `${slotOffsetOf(addr)}(${base}${index})`;
  }

  symbolText(name: string): string {
    return `${this.format.symbolPrefix}${name}`;
  }

  private printedOperands(node: MachineInstruction): MachineOperand[] {
    const limit = node.flags.implicitFrom ?? node.operands.length;
    const printed = node.operands.slice(0, limit);
    if (node.flags.tied === true) printed.splice(1, 1);
    return printed;
  }

  instructionText(node: MachineInstruction): string[] {
    if (node.opcode === "ret") return [...this.epilogue(), "\tret"];
    const operands = this.printedOperands(node)
      .reverse()
      .map((operand) => this.operandText(operand));
    return [operands.length === 0 ? `\t${node.opcode}` : `\t${node.opcode} ${operands.join(", ")}`];
  }

  private saveText(store: boolean): string[] {
    const lines: string[] = [];
    for (const saved of this.frame.saved) {
      const float = saved.register.classId === X64_FPR;
      const mnemonic = float ? "movups" : "movq";
      const register = `%${x64RegisterName(saved.register, ADDRESS_WIDTH)}`;
      const location = `${saved.offset}(%rsp)`;
      lines.push(store ? `\t${mnemonic} ${register}, ${location}` : `\t${mnemonic} ${location}, ${register}`);
    }
    return lines;
  }

  prologue(): string[] {
    const lines: string[] = [];
    if (this.frame.frameSize > 0) lines.push(`\tsubq $${this.frame.frameSize}, %rsp`);
    lines.push(...this.saveText(true));
    return lines;
  }

  epilogue(): string[] {
    const lines = this.saveText(false);
    if (this.frame.frameSize > 0) lines.push(`\taddq $${this.frame.frameSize}, %rsp`);
    return lines;
  }

  functionText(fn: MachineFunction, frame: FrameLayout): string {
    this.frame = frame;
    const symbol = this.symbolText(fn.symbol);
    const lines: string[] = [
      this.format.textDirective,
      "\t.p2align 4",
      `\t.globl ${symbol}`,
      ...this.format.functionAttributes(symbol),
      `${symbol}:`,
      ...this.prologue(),
    ];
    for (const block of fn.blocks) {
      lines.push(`${block.label}:`);
      for (const node of block.instructions) lines.push(...this.instructionText(node));
    }
    return `${lines.join("\n")}\n`;
  }

  dataText(items: readonly MachineDatum[]): string {
    return machineDataText(items, {
      readOnly: this.format.rodataDirective,
      writable: this.format.dataDirective,
    });
  }

  runtimeText(symbol: string, body: string): string {
    const name = this.symbolText(symbol);
    const lines = [this.format.textDirective, "\t.p2align 4", `${name}:`, body];
    return `${lines.join("\n")}\n`;
  }
}
