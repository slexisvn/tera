import { describe, expect, it } from "vitest";
import {
  def,
  instruction,
  isVirtual,
  MachineFunction,
  use,
  type MachineBlock,
  type VirtualRegister,
} from "../../../src/optimizing/machine/ir.js";
import { assignPositions, computeLiveness } from "../../../src/optimizing/machine/liveness.js";
import { allocateRegisters } from "../../../src/optimizing/machine/linear-scan.js";
import { rewriteAllocations } from "../../../src/optimizing/machine/rewrite.js";
import { lowerTwoAddress } from "../../../src/optimizing/machine/two-address.js";
import {
  expectDisjointAllocation,
  expectFullyAllocated,
  testLowering,
  testTarget,
  TEST_GPR,
} from "./support.js";

const target = testTarget();
const lowering = testLowering(target);

function allocate(fn: MachineFunction) {
  assignPositions(fn);
  const liveness = computeLiveness(fn);
  const allocation = allocateRegisters(fn, target, liveness);
  return { liveness, allocation };
}

function overlapping(count: number): {
  fn: MachineFunction;
  block: MachineBlock;
  values: VirtualRegister[];
} {
  const fn = new MachineFunction("pressure", "pressure");
  const block = fn.createBlock(".L0");
  const values: VirtualRegister[] = [];
  for (let index = 0; index < count; index++) {
    const value = fn.createVirtual(TEST_GPR, 8);
    values.push(value);
    block.instructions.push(instruction("define", [def(value, 8)]));
  }
  for (let index = 0; index + 1 < values.length; index += 2) {
    block.instructions.push(
      instruction("consume", [use(values[index]!, 8), use(values[index + 1]!, 8)]),
    );
  }
  block.instructions.push(instruction("consume", [use(values[values.length - 1]!, 8)]));
  return { fn, block, values };
}

describe("linear scan allocation", () => {
  it("gives simultaneously live values distinct registers", () => {
    const { fn, values } = overlapping(4);
    const { liveness, allocation } = allocate(fn);

    expect(allocation.spilled).toEqual([]);
    expectDisjointAllocation(liveness, allocation);
    const assigned = values.map(
      (value) => liveness.intervalOf(value)!.assigned!.name,
    );
    expect(new Set(assigned).size).toBe(4);
  });

  it("spills only what does not fit and keeps the rest disjoint", () => {
    const { fn, values } = overlapping(7);
    const { liveness, allocation } = allocate(fn);

    expect(allocation.spilled.length).toBe(3);
    expectDisjointAllocation(liveness, allocation);
    for (const interval of allocation.intervals) {
      expect(interval.assigned !== null || interval.spillSlot !== null).toBe(true);
    }
    expect(values.length).toBe(7);
  });

  it("never reuses a register a fixed interval is holding", () => {
    const fn = new MachineFunction("fixed", "fixed");
    const block = fn.createBlock(".L0");
    const reserved = target.registers.register("a0");
    const value = fn.createVirtual(TEST_GPR, 8);

    block.instructions.push(instruction("define", [def(value, 8)]));
    block.instructions.push(instruction("clobber", [def(reserved, 8)]));
    block.instructions.push(instruction("consume", [use(value, 8), use(reserved, 8)]));

    const { liveness, allocation } = allocate(fn);
    expect(liveness.intervalOf(value)!.assigned).not.toBe(reserved);
    expectDisjointAllocation(liveness, allocation);
  });

  it("keeps values in separate register classes independent", () => {
    const fn = new MachineFunction("classes", "classes");
    const block = fn.createBlock(".L0");
    const integers = [0, 1, 2, 3].map(() => fn.createVirtual(TEST_GPR, 8));
    const floats = [0, 1].map(() => fn.createVirtual("fpr", 8));
    for (const value of [...integers, ...floats]) {
      block.instructions.push(instruction("define", [def(value, 8)]));
    }
    block.instructions.push(
      instruction("consume", [...integers, ...floats].map((value) => use(value, 8))),
    );

    const { liveness, allocation } = allocate(fn);
    expect(allocation.spilled).toEqual([]);
    expectDisjointAllocation(liveness, allocation);
  });

  it("reports callee saved registers it decided to use", () => {
    const { fn } = overlapping(4);
    const { allocation } = allocate(fn);

    expect(allocation.usedCalleeSaved.map((register) => register.name).sort()).toEqual([
      "a2",
      "a3",
    ]);
  });
});

describe("spill rewriting", () => {
  it("reloads before the use and stores after the definition", () => {
    const { fn } = overlapping(7);
    const { allocation } = allocate(fn);
    rewriteAllocations(fn, target, lowering, allocation);

    expectFullyAllocated(fn);
    const opcodes = fn.blocks[0]!.instructions.map((node) => node.opcode);
    expect(opcodes.filter((opcode) => opcode === "store").length).toBe(3);
    expect(opcodes.filter((opcode) => opcode === "reload").length).toBeGreaterThan(0);
    expect(opcodes.indexOf("store")).toBeLessThan(opcodes.indexOf("reload"));
  });

  it("fails loudly when one instruction needs more scratch than the target reserves", () => {
    const fn = new MachineFunction("scratch", "scratch");
    const block = fn.createBlock(".L0");
    const values = [0, 1, 2].map(() => fn.createVirtual(TEST_GPR, 8));
    for (const value of values) {
      block.instructions.push(instruction("define", [def(value, 8)]));
    }
    block.instructions.push(
      instruction("wide", values.map((value) => use(value, 8))),
    );

    const { allocation } = allocate(fn);
    for (const interval of allocation.intervals) {
      interval.assigned = null;
      interval.spillSlot = fn.createSlot(8, 8);
    }

    expect(() => rewriteAllocations(fn, target, lowering, allocation)).toThrow(
      /more spilled gpr operands/,
    );
  });
});

describe("two address lowering", () => {
  it("copies the first source into the destination and ties the operand", () => {
    const fn = new MachineFunction("tied", "tied");
    const block = fn.createBlock(".L0");
    const left = fn.createVirtual(TEST_GPR, 8);
    const right = fn.createVirtual(TEST_GPR, 8);
    const result = fn.createVirtual(TEST_GPR, 8);
    block.instructions.push(instruction("define", [def(left, 8)]));
    block.instructions.push(instruction("define", [def(right, 8)]));
    block.instructions.push(
      instruction("sub", [def(result, 8), use(left, 8), use(right, 8)], { tied: true }),
    );

    expect(lowerTwoAddress(fn, lowering)).toBe(1);
    const [, , copy, subtract] = block.instructions;
    expect(copy!.opcode).toBe("copy");
    expect(copy!.operands[0]).toMatchObject({ register: result });
    expect(copy!.operands[1]).toMatchObject({ register: left });
    expect(subtract!.operands[1]).toMatchObject({ register: result });
  });

  it("leaves an already destructive instruction alone", () => {
    const fn = new MachineFunction("already", "already");
    const block = fn.createBlock(".L0");
    const value = fn.createVirtual(TEST_GPR, 8);
    const other = fn.createVirtual(TEST_GPR, 8);
    block.instructions.push(
      instruction("add", [def(value, 8), use(value, 8), use(other, 8)], { tied: true }),
    );

    expect(lowerTwoAddress(fn, lowering)).toBe(0);
    expect(block.instructions).toHaveLength(1);
  });

  it("rejects a tied instruction that is not in destructive form", () => {
    const fn = new MachineFunction("bad", "bad");
    const block = fn.createBlock(".L0");
    const value = fn.createVirtual(TEST_GPR, 8);
    block.instructions.push(instruction("odd", [use(value, 8)], { tied: true }));

    expect(() => lowerTwoAddress(fn, lowering)).toThrow(/destructive form/);
  });
});

describe("allocation output", () => {
  it("leaves no virtual register behind", () => {
    const { fn } = overlapping(3);
    const { allocation } = allocate(fn);
    rewriteAllocations(fn, target, lowering, allocation);

    for (const block of fn.blocks) {
      for (const node of block.instructions) {
        for (const operand of node.operands) {
          if (operand.kind !== "register") continue;
          expect(isVirtual(operand.register)).toBe(false);
        }
      }
    }
  });
});
