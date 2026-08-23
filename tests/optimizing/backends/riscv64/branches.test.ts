import { describe, expect, it } from "vitest";
import { RiscvLowering } from "../../../../src/optimizing/backends/riscv64/lowering.js";
import { riscvTarget } from "../../../../src/optimizing/backends/riscv64/target.js";
import {
  instruction,
  label,
  use,
  MachineBlock,
  type MachineInstruction,
} from "../../../../src/optimizing/machine/ir.js";

const lowering = new RiscvLowering(riscvTarget());
const elsewhere = new MachineBlock(1, ".Lelsewhere");

function register(name: string) {
  return use(lowering.target.registers.register(name), 8);
}

function branch(opcode: string): MachineInstruction {
  return instruction(opcode, [register("a0"), register("a1"), label(new MachineBlock(0, ".Ltaken"))], {
    terminator: true,
  });
}

function inverted(opcode: string): string | null {
  return lowering.invertBranch(branch(opcode), elsewhere)?.opcode ?? null;
}

describe("riscv64 branch inversion", () => {
  it("swaps each conditional branch with the one that answers the opposite", () => {
    expect(inverted("beq")).toBe("bne");
    expect(inverted("bne")).toBe("beq");
    expect(inverted("blt")).toBe("bge");
    expect(inverted("bge")).toBe("blt");
    expect(inverted("bltu")).toBe("bgeu");
    expect(inverted("bgeu")).toBe("bltu");
  });

  it("keeps the compared registers and retargets the label", () => {
    const flipped = lowering.invertBranch(branch("blt"), elsewhere)!;

    expect(flipped.operands.slice(0, 2)).toEqual(branch("blt").operands.slice(0, 2));
    expect(flipped.operands[2]).toMatchObject({ kind: "label", block: elsewhere });
    expect(flipped.flags.terminator).toBe(true);
  });

  it("refuses an unconditional jump and anything it does not know", () => {
    expect(inverted("j")).toBeNull();
    expect(lowering.invertBranch(lowering.jump(elsewhere), elsewhere)).toBeNull();
  });
});
