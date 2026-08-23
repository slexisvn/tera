import { describe, expect, it } from "vitest";
import {
  def,
  instruction,
  label,
  use,
  MachineFunction,
  type MachineBlock,
} from "../../../src/optimizing/machine/ir.js";
import { peepholeMachineCode } from "../../../src/optimizing/machine/peephole.js";
import { testLowering, testTarget } from "./support.js";

const lowering = testLowering(testTarget());

function physical(name: string) {
  return lowering.target.registers.register(name);
}

function functionOf(labels: readonly string[]): {
  fn: MachineFunction;
  blocks: MachineBlock[];
} {
  const fn = new MachineFunction("probe", "probe");
  return { fn, blocks: labels.map((name) => fn.createBlock(name)) };
}

const opcodes = (block: MachineBlock): string[] =>
  block.instructions.map((node) => node.opcode);

describe("peepholeMachineCode", () => {
  it("drops a jump to the block that already follows it", () => {
    const { fn, blocks } = functionOf(["head", "tail"]);
    blocks[0]!.instructions.push(lowering.jump(blocks[1]!));

    expect(peepholeMachineCode(fn, lowering)).toBe(1);
    expect(opcodes(blocks[0]!)).toEqual([]);
  });

  it("keeps a jump that skips over the next block", () => {
    const { fn, blocks } = functionOf(["head", "middle", "tail"]);
    blocks[0]!.instructions.push(lowering.jump(blocks[2]!));

    expect(peepholeMachineCode(fn, lowering)).toBe(0);
    expect(opcodes(blocks[0]!)).toEqual(["jump"]);
  });

  it("keeps a conditional branch that names the next block", () => {
    const { fn, blocks } = functionOf(["head", "tail"]);
    blocks[0]!.instructions.push(
      instruction("jle", [label(blocks[1]!)], { terminator: true }),
    );

    expect(peepholeMachineCode(fn, lowering)).toBe(0);
    expect(opcodes(blocks[0]!)).toEqual(["jle"]);
  });

  it("keeps the jump the last block makes", () => {
    const { fn, blocks } = functionOf(["head", "tail"]);
    blocks[1]!.instructions.push(lowering.jump(blocks[0]!));

    expect(peepholeMachineCode(fn, lowering)).toBe(0);
    expect(opcodes(blocks[1]!)).toEqual(["jump"]);
  });

  it("drops a copy from a register into itself", () => {
    const { fn, blocks } = functionOf(["head"]);
    const held = physical("a0");
    blocks[0]!.instructions.push(
      instruction("move", [def(held, 8), use(held, 8)], { copy: true }),
    );

    expect(peepholeMachineCode(fn, lowering)).toBe(1);
    expect(opcodes(blocks[0]!)).toEqual([]);
  });

  it("keeps a copy between two different registers", () => {
    const { fn, blocks } = functionOf(["head"]);
    blocks[0]!.instructions.push(
      instruction("move", [def(physical("a0"), 8), use(physical("a1"), 8)], { copy: true }),
    );

    expect(peepholeMachineCode(fn, lowering)).toBe(0);
    expect(opcodes(blocks[0]!)).toEqual(["move"]);
  });

  it("keeps a copy that narrows a register into itself", () => {
    const { fn, blocks } = functionOf(["head"]);
    const held = physical("a0");
    blocks[0]!.instructions.push(
      instruction("move", [def(held, 4), use(held, 8)], { copy: true }),
    );

    expect(peepholeMachineCode(fn, lowering)).toBe(0);
    expect(opcodes(blocks[0]!)).toEqual(["move"]);
  });

  it("inverts a conditional so the block falls into its untaken side", () => {
    const { fn, blocks } = functionOf(["head", "taken", "untaken"]);
    blocks[0]!.instructions.push(
      instruction("jle", [label(blocks[1]!)], { terminator: true }),
      lowering.jump(blocks[2]!),
    );

    expect(peepholeMachineCode(fn, lowering)).toBe(1);
    expect(opcodes(blocks[0]!)).toEqual(["jg"]);
    const branch = blocks[0]!.instructions[0]!;
    expect(branch.operands[0]).toMatchObject({ kind: "label", block: blocks[2]! });
  });

  it("leaves a conditional alone when the fallthrough is already its untaken side", () => {
    const { fn, blocks } = functionOf(["head", "untaken", "taken"]);
    blocks[0]!.instructions.push(
      instruction("jle", [label(blocks[2]!)], { terminator: true }),
      lowering.jump(blocks[1]!),
    );

    expect(peepholeMachineCode(fn, lowering)).toBe(1);
    expect(opcodes(blocks[0]!)).toEqual(["jle"]);
  });

  it("leaves a conditional it cannot invert alone", () => {
    const { fn, blocks } = functionOf(["head", "taken", "untaken"]);
    blocks[0]!.instructions.push(
      instruction("jzzz", [label(blocks[1]!)], { terminator: true }),
      lowering.jump(blocks[2]!),
    );

    expect(peepholeMachineCode(fn, lowering)).toBe(0);
    expect(opcodes(blocks[0]!)).toEqual(["jzzz", "jump"]);
  });
});
