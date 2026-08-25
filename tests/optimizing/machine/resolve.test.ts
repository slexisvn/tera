import { describe, expect, it } from "vitest";
import {
  def,
  instruction,
  label,
  use,
  MachineFunction,
  type MachineBlock,
  type VirtualRegister,
} from "../../../src/optimizing/machine/ir.js";
import { assignPositions, computeLiveness } from "../../../src/optimizing/machine/liveness.js";
import { allocateRegisters } from "../../../src/optimizing/machine/linear-scan.js";
import { rewriteAllocations } from "../../../src/optimizing/machine/rewrite.js";
import { expectFullyAllocated, testLowering, testTarget, TEST_GPR } from "./support.js";

const target = testTarget();
const lowering = testLowering(target);

function connect(from: MachineBlock, to: MachineBlock): void {
  from.successors.push(to);
  to.predecessors.push(from);
}

function crowdedAcrossBlocks(): { fn: MachineFunction; value: VirtualRegister; exit: MachineBlock } {
  const fn = new MachineFunction("across", "across");
  const entry = fn.createBlock(".L0");
  const middle = fn.createBlock(".L1");
  const exit = fn.createBlock(".L2");
  connect(entry, middle);
  connect(middle, exit);

  const value = fn.createVirtual(TEST_GPR, 8);
  const held = ["a0", "a1", "a2", "a3"].map((name) => target.registers.register(name));

  entry.instructions.push(instruction("define", [def(value, 8)]));
  entry.instructions.push(instruction("jump", [label(middle)], { terminator: true }));

  for (const register of held) {
    middle.instructions.push(instruction("define", [def(register, 8)]));
  }
  middle.instructions.push(instruction("consume", held.map((register) => use(register, 8))));
  middle.instructions.push(instruction("jump", [label(exit)], { terminator: true }));

  for (const _ of [0, 1, 2]) {
    exit.instructions.push(instruction("consume", [use(value, 8)]));
  }
  return { fn, value, exit };
}

function allocate(fn: MachineFunction) {
  assignPositions(fn);
  const liveness = computeLiveness(fn);
  return allocateRegisters(fn, target, liveness, true);
}

describe("resolving a value split across a block boundary", () => {
  it("splits the value rather than spilling it for its whole life", () => {
    const { fn, value, exit } = crowdedAcrossBlocks();
    const allocation = allocate(fn);

    expect(allocation.splitRegisters).toContain(value);
    expect(allocation.locationAt(value, exit.from)!.assigned).not.toBeNull();
  });

  it("reloads it once, in the block that reads it", () => {
    const { fn, exit } = crowdedAcrossBlocks();
    const allocation = allocate(fn);
    rewriteAllocations(fn, target, lowering, allocation);

    expectFullyAllocated(fn);
    const opcodes = fn.blocks.map((block) =>
      block.instructions.filter((node) => node.opcode === "reload").length,
    );
    expect(opcodes).toEqual([0, 0, 1]);
    expect(exit.instructions[0]!.opcode).toBe("reload");
  });

  it("stores it once, before the block that crowds it out", () => {
    const { fn } = crowdedAcrossBlocks();
    const allocation = allocate(fn);
    rewriteAllocations(fn, target, lowering, allocation);

    const stores = fn.blocks.map((block) =>
      block.instructions.filter((node) => node.opcode === "store").length,
    );
    expect(stores.reduce((total, count) => total + count, 0)).toBe(1);
  });
});
