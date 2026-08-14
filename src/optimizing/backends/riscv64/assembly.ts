import {
  explicitOperandsOf,
  slotOffsetOf,
  type MachineDatum,
  type MachineFunction,
  type MachineInstruction,
  type MachineOperand,
} from "../../machine/ir.js";
import type { FrameLayout } from "../../machine/frame.js";
import { machineDataText } from "../../machine/data.js";
import { BackendLoweringError } from "../../target/errors.js";
import { fitsImmediate } from "./immediates.js";

export class RiscvAssemblyWriter {
  private registerText(operand: MachineOperand): string {
    if (operand.kind !== "register") throw new Error("expected a register operand");
    if (operand.register.kind !== "physical") {
      throw new Error("virtual register survived to assembly emission");
    }
    return operand.register.name;
  }

  private operandText(operand: MachineOperand): string {
    if (operand.kind === "register") return this.registerText(operand);
    if (operand.kind === "immediate") return String(operand.value);
    if (operand.kind === "symbol") return operand.name;
    if (operand.kind === "label") return operand.block.label;
    const addr = operand.address;
    if (addr.symbol !== null) {
      return addr.displacement === 0 ? addr.symbol : `${addr.symbol}+${addr.displacement}`;
    }
    const offset = slotOffsetOf(addr);
    if (!fitsImmediate(offset)) {
      throw new BackendLoweringError(
        `riscv64 stack offset ${offset} does not fit a 12 bit immediate`,
      );
    }
    if (addr.base === null) return String(offset);
    return `${offset}(${this.registerText(addr.base)})`;
  }

  private printedOperands(node: MachineInstruction): MachineOperand[] {
    return explicitOperandsOf(node);
  }

  instructionText(node: MachineInstruction): string[] {
    const operands = this.printedOperands(node).map((operand) =>
      this.operandText(operand),
    );
    return [
      operands.length === 0 ? `\t${node.opcode}` : `\t${node.opcode} ${operands.join(", ")}`,
    ];
  }

  functionText(fn: MachineFunction, exported = true): string {
    const symbol = fn.symbol;
    const lines: string[] = [
      "\t.text",
      "\t.p2align 2",
      ...(exported ? [`\t.globl ${symbol}`, `\t.type ${symbol}, @function`] : []),
      `${symbol}:`,
    ];
    for (const block of fn.blocks) {
      lines.push(`${block.label}:`);
      for (const node of block.instructions) lines.push(...this.instructionText(node));
    }
    lines.push(`\t.size ${symbol}, .-${symbol}`);
    return `${lines.join("\n")}\n`;
  }

  dataText(items: readonly MachineDatum[]): string {
    return machineDataText(items, { readOnly: "\t.section .rodata", writable: "\t.data" });
  }

}
