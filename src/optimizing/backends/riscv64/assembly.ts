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
import { annotateCfi, CFI_END, CFI_START } from "../../machine/cfi-text.js";
import { annotateLines, SourceFiles } from "../../machine/line-text.js";
import { prologueEffectOf, riscvCfiTarget } from "./unwind.js";
import { BackendLoweringError } from "../../target/errors.js";
import { fitsImmediate } from "./immediates.js";

export class RiscvAssemblyWriter {
  readonly sourceFiles = new SourceFiles();

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
    const cfi = annotateCfi(fn, riscvCfiTarget, prologueEffectOf);
    const lines: string[] = [
      "\t.text",
      "\t.p2align 2",
      ...(exported ? [`\t.globl ${symbol}`, `\t.type ${symbol}, @function`] : []),
      `${symbol}:`,
      ...(cfi.describes ? [CFI_START] : []),
    ];
    const located = annotateLines(this.sourceFiles);
    for (const block of fn.blocks) {
      lines.push(`${block.label}:`);
      for (const node of block.instructions) {
        lines.push(...located(node), ...this.instructionText(node), ...cfi.after(node));
      }
    }
    if (cfi.describes) lines.push(CFI_END);
    lines.push(`\t.size ${symbol}, .-${symbol}`);
    return `${lines.join("\n")}\n`;
  }

  dataText(items: readonly MachineDatum[]): string {
    return machineDataText(items, { readOnly: "\t.section .rodata", writable: "\t.data" });
  }

}
