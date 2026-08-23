import { describe, expect, it } from "vitest";
import {
  def,
  imm,
  instruction,
  label,
  mem,
  sym,
  use,
  MachineBlock,
  MachineFunction,
  type MachineInstruction,
  type VirtualRegister,
} from "../../../src/optimizing/machine/ir.js";
import {
  scheduleMachineCode,
  type InstructionEffect,
} from "../../../src/optimizing/machine/schedule.js";
import type { MachineLowering } from "../../../src/optimizing/machine/lowering.js";
import { testLowering, testTarget, TEST_GPR } from "./support.js";

const SLOW = 14;

const EFFECTS: ReadonlyMap<string, InstructionEffect> = new Map<string, InstructionEffect>([
  ["divide", { latency: SLOW }],
  ["compare", { writesFlags: true }],
  ["add", { writesFlags: true }],
  ["choose", { readsFlags: true }],
  ["move", {}],
  ["load", {}],
  ["store", {}],
  ["copy", {}],
  ["jump", {}],
  ["ret", {}],
]);

function lowering(): MachineLowering {
  const base = testLowering(testTarget());
  return { ...base, effectOf: (node) => EFFECTS.get(node.opcode) ?? {} };
}

let nextId = 0;
function virtual(): VirtualRegister {
  return { kind: "virtual", id: nextId++, classId: TEST_GPR, width: 8 };
}

function blockOf(instructions: readonly MachineInstruction[]): {
  fn: MachineFunction;
  block: MachineBlock;
} {
  const fn = new MachineFunction("scheduled", "scheduled");
  const block = fn.createBlock(".Lscheduled");
  block.instructions.push(...instructions);
  return { fn, block };
}

function opcodesAfterScheduling(instructions: readonly MachineInstruction[]): string[] {
  const { fn, block } = blockOf(instructions);
  scheduleMachineCode(fn, lowering());
  return block.instructions.map((node) => node.opcode);
}

describe("machine scheduling", () => {
  it("starts a long chain before the work that does not depend on it", () => {
    const slow = virtual();
    const other = virtual();
    const order = opcodesAfterScheduling([
      instruction("move", [def(other, 8), imm(1)]),
      instruction("divide", [def(slow, 8), imm(7)]),
      instruction("store", [mem(8, { base: use(slow, 8) }), use(other, 8)]),
    ]);

    expect(order).toEqual(["divide", "move", "store"]);
  });

  it("leaves an order it cannot improve alone", () => {
    const value = virtual();
    const { fn, block } = blockOf([
      instruction("move", [def(value, 8), imm(1)]),
      instruction("add", [def(value, 8), use(value, 8), imm(2)], { tied: true }),
    ]);

    expect(scheduleMachineCode(fn, lowering())).toBe(0);
    expect(block.instructions.map((node) => node.opcode)).toEqual(["move", "add"]);
  });

  it("never lets another flag writer come between a compare and its reader", () => {
    const left = virtual();
    const chosen = virtual();
    const counter = virtual();
    const order = opcodesAfterScheduling([
      instruction("divide", [def(left, 8), imm(9)]),
      instruction("compare", [use(left, 8), imm(0)]),
      instruction("choose", [def(chosen, 8), imm(1)]),
      instruction("add", [def(counter, 8), imm(2)]),
    ]);

    expect(order.indexOf("add")).not.toBe(order.indexOf("compare") + 1);
    expect(order.indexOf("choose")).toBe(order.indexOf("compare") + 1);
  });

  it("keeps memory in the order the selector wrote it", () => {
    const address = virtual();
    const loaded = virtual();
    const order = opcodesAfterScheduling([
      instruction("move", [def(address, 8), imm(0)]),
      instruction("store", [mem(8, { base: use(address, 8) }), imm(1)]),
      instruction("load", [def(loaded, 8), mem(8, { base: use(address, 8) })]),
      instruction("store", [mem(8, { base: use(address, 8) }), use(loaded, 8)]),
    ]);

    expect(order).toEqual(["move", "store", "load", "store"]);
  });

  it("does not move anything across a call", () => {
    const before = virtual();
    const after = virtual();
    const order = opcodesAfterScheduling([
      instruction("move", [def(before, 8), imm(1)]),
      instruction("call", [sym("elsewhere")], { call: true, implicitFrom: 1 }),
      instruction("divide", [def(after, 8), imm(2)]),
      instruction("move", [def(after, 8), use(before, 8)]),
    ]);

    expect(order).toEqual(["move", "call", "divide", "move"]);
  });

  it("moves nothing across a branch that sits in the middle of a block", () => {
    const cursor = virtual();
    const next = virtual();
    const size = virtual();
    const other = virtual();
    const taken = new MachineBlock(1, ".Ltaken");
    const order = opcodesAfterScheduling([
      instruction("load", [def(cursor, 8), mem(8, { symbol: "arena" })]),
      instruction("divide", [def(next, 8), use(cursor, 8)]),
      instruction("compare", [use(next, 8), imm(0)]),
      instruction("move", [def(size, 8), imm(16)]),
      instruction("choose", [use(size, 8), label(taken)]),
      instruction("store", [mem(8, { symbol: "arena" }), use(next, 8)]),
      instruction("load", [def(other, 8), mem(8, { symbol: "arena" })]),
    ]);
    const branch = order.indexOf("choose");

    expect(order.slice(0, branch)).toEqual(["load", "divide", "compare", "move"]);
    expect(order.slice(branch + 1)).toEqual(["store", "load"]);
  });

  it("leaves the terminator and the copies that feed it in place", () => {
    const value = virtual();
    const held = virtual();
    const target = new MachineBlock(1, ".Lelsewhere");
    const order = opcodesAfterScheduling([
      instruction("move", [def(value, 8), imm(1)]),
      instruction("divide", [def(value, 8), imm(2)]),
      instruction("copy", [def(held, 8), use(value, 8)], { copy: true }),
      instruction("jump", [label(target)], { terminator: true }),
    ]);

    expect(order.slice(2)).toEqual(["copy", "jump"]);
  });
});
