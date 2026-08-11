import {
  slotOffsetOf,
  type MachineDatum,
  type MachineFunction,
  type MachineInstruction,
  type MachineOperand,
} from "../../machine/ir.js";
import type { FrameLayout } from "../../machine/frame.js";
import { machineDataText } from "../../machine/data.js";
import { BackendLoweringError } from "../../target/errors.js";
import { RISCV_FPR } from "./registers.js";

const IMMEDIATE_LIMIT = 2047;
const EMPTY_FRAME: FrameLayout = {
  outgoingBytes: 0,
  localBytes: 0,
  frameSize: 0,
  saved: [],
};

export class RiscvAssemblyWriter {
  private frame: FrameLayout = EMPTY_FRAME;

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
    if (addr.symbol !== null) return addr.symbol;
    const offset = slotOffsetOf(addr);
    if (offset > IMMEDIATE_LIMIT || offset < -IMMEDIATE_LIMIT - 1) {
      throw new BackendLoweringError(
        `riscv64 stack offset ${offset} does not fit a 12 bit immediate`,
      );
    }
    return `${offset}(${addr.base === null ? "zero" : this.registerText(addr.base)})`;
  }

  private printedOperands(node: MachineInstruction): MachineOperand[] {
    return node.operands.slice(0, node.flags.implicitFrom ?? node.operands.length);
  }

  instructionText(node: MachineInstruction): string[] {
    if (node.opcode === "ret") return [...this.epilogue(), "\tret"];
    const operands = this.printedOperands(node).map((operand) =>
      this.operandText(operand),
    );
    return [
      operands.length === 0 ? `\t${node.opcode}` : `\t${node.opcode} ${operands.join(", ")}`,
    ];
  }

  private saveText(store: boolean): string[] {
    const lines: string[] = [];
    for (const saved of this.frame.saved) {
      const float = saved.register.classId === RISCV_FPR;
      const mnemonic = store ? (float ? "fsd" : "sd") : float ? "fld" : "ld";
      lines.push(`\t${mnemonic} ${saved.register.name}, ${saved.offset}(sp)`);
    }
    return lines;
  }

  private adjust(delta: number): string[] {
    if (delta === 0) return [];
    if (Math.abs(delta) <= IMMEDIATE_LIMIT) return [`\taddi sp, sp, ${delta}`];
    return [`\tli t0, ${delta}`, "\tadd sp, sp, t0"];
  }

  prologue(): string[] {
    return [...this.adjust(-this.frame.frameSize), ...this.saveText(true)];
  }

  epilogue(): string[] {
    return [...this.saveText(false), ...this.adjust(this.frame.frameSize)];
  }

  functionText(fn: MachineFunction, frame: FrameLayout): string {
    this.frame = frame;
    const symbol = fn.symbol;
    const lines: string[] = [
      "\t.text",
      "\t.p2align 2",
      `\t.globl ${symbol}`,
      `\t.type ${symbol}, @function`,
      `${symbol}:`,
      ...this.prologue(),
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

  runtimeText(symbol: string, body: string): string {
    return `${["\t.text", "\t.p2align 2", `${symbol}:`, body].join("\n")}\n`;
  }
}
