import type { MachineDatum, MachineFunction, MachineInstruction, MachineOperand } from "../../machine/ir.js";
import { explicitOperandsOf, slotOffsetOf } from "../../machine/ir.js";
import { machineDataText } from "../../machine/data.js";
import type { FrameLayout } from "../../machine/frame.js";
import { X64_FPR } from "./registers.js";
import { x64RegisterName } from "./registers.js";
import type { ObjectFormat } from "./format.js";
import type { X64TargetModel } from "./target.js";

const ADDRESS_WIDTH = 8;
const INDIRECT_MARKER = "*";

export class X64AssemblyWriter {
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
    if (addr.symbol !== null) {
      const offset = addr.displacement === 0 ? "" : `+${addr.displacement}`;
      return `${addr.symbol}${offset}(%rip)`;
    }
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
    return explicitOperandsOf(node, { dropTiedSource: true });
  }

  private targetText(node: MachineInstruction, operand: MachineOperand): string {
    const indirect =
      node.flags.call === true && (operand.kind === "memory" || operand.kind === "register");
    return `${indirect ? INDIRECT_MARKER : ""}${this.operandText(operand)}`;
  }

  instructionText(node: MachineInstruction): string[] {
    const operands = this.printedOperands(node)
      .reverse()
      .map((operand) => this.targetText(node, operand));
    return [operands.length === 0 ? `\t${node.opcode}` : `\t${node.opcode} ${operands.join(", ")}`];
  }

  functionText(fn: MachineFunction, exported = true): string {
    const symbol = this.symbolText(fn.symbol);
    const lines: string[] = [
      this.format.textDirective,
      "\t.p2align 4",
      ...(exported
        ? [`\t.globl ${symbol}`, ...this.format.functionAttributes(symbol)]
        : []),
      `${symbol}:`,
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
}
