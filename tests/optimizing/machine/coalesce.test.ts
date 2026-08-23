import { describe, expect, it } from "vitest";
import {
  def,
  instruction,
  use,
  MachineFunction,
  type MachineBlock,
  type MachineInstruction,
} from "../../../src/optimizing/machine/ir.js";
import { coalesceRoundTrips } from "../../../src/optimizing/machine/coalesce.js";
import { testLowering, testTarget } from "./support.js";

const lowering = testLowering(testTarget());
const convention = lowering.target.abi.callingConvention;

function physical(name: string) {
  return lowering.target.registers.register(name);
}

function copy(into: string, from: string): MachineInstruction {
  return instruction("move", [def(physical(into), 8), use(physical(from), 8)], { copy: true });
}

function accumulate(into: string, addend: string): MachineInstruction {
  return instruction(
    "add",
    [def(physical(into), 8), use(physical(into), 8), use(physical(addend), 8)],
    { tied: true },
  );
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

const namesIn = (node: MachineInstruction): string[] =>
  node.operands.flatMap((operand) =>
    operand.kind === "register" && operand.register.kind === "physical"
      ? [operand.register.name]
      : [],
  );

describe("coalesceRoundTrips", () => {
  it("accumulates into the held register when the scratch dies right after", () => {
    const { fn, blocks } = functionOf(["loop", "exit"]);
    blocks[0]!.instructions.push(copy("a1", "a0"), accumulate("a1", "a2"), copy("a0", "a1"));
    blocks[0]!.successors.push(blocks[1]!);
    blocks[1]!.predecessors.push(blocks[0]!);
    blocks[1]!.instructions.push(instruction("ret", [use(physical("a0"), 8)], { returns: true }));

    expect(coalesceRoundTrips(fn, convention)).toBe(2);
    expect(opcodes(blocks[0]!)).toEqual(["add"]);
    expect(namesIn(blocks[0]!.instructions[0]!)).toEqual(["a0", "a0", "a2"]);
  });

  it("writes a computed value straight into the register it is copied to", () => {
    const { fn, blocks } = functionOf(["body", "exit"]);
    blocks[0]!.instructions.push(
      instruction("step", [def(physical("a1"), 8), use(physical("a2"), 8)]),
      copy("a0", "a1"),
    );
    blocks[0]!.successors.push(blocks[1]!);
    blocks[1]!.predecessors.push(blocks[0]!);
    blocks[1]!.instructions.push(instruction("ret", [use(physical("a0"), 8)], { returns: true }));

    expect(coalesceRoundTrips(fn, convention)).toBe(1);
    expect(opcodes(blocks[0]!)).toEqual(["step"]);
    expect(namesIn(blocks[0]!.instructions[0]!)).toEqual(["a0", "a2"]);
  });

  it("folds even when the computation reads the register it will write", () => {
    const { fn, blocks } = functionOf(["body", "exit"]);
    blocks[0]!.instructions.push(
      instruction("step", [def(physical("a1"), 8), use(physical("a0"), 8)]),
      copy("a0", "a1"),
    );
    blocks[0]!.successors.push(blocks[1]!);
    blocks[1]!.predecessors.push(blocks[0]!);
    blocks[1]!.instructions.push(instruction("ret", [use(physical("a0"), 8)], { returns: true }));

    expect(coalesceRoundTrips(fn, convention)).toBe(1);
    expect(namesIn(blocks[0]!.instructions[0]!)).toEqual(["a0", "a0"]);
  });

  it("keeps the copy when something between reads the register it would write", () => {
    const { fn, blocks } = functionOf(["body", "exit"]);
    blocks[0]!.instructions.push(
      instruction("step", [def(physical("a1"), 8), use(physical("a2"), 8)]),
      instruction("peek", [def(physical("a3"), 8), use(physical("a0"), 8)]),
      copy("a0", "a1"),
    );
    blocks[0]!.successors.push(blocks[1]!);
    blocks[1]!.predecessors.push(blocks[0]!);
    blocks[1]!.instructions.push(instruction("ret", [use(physical("a0"), 8)], { returns: true }));

    expect(coalesceRoundTrips(fn, convention)).toBe(0);
    expect(opcodes(blocks[0]!)).toEqual(["step", "peek", "move"]);
  });

  it("keeps the round trip when the scratch is read afterwards", () => {
    const { fn, blocks } = functionOf(["loop", "exit"]);
    blocks[0]!.instructions.push(copy("a1", "a0"), accumulate("a1", "a2"), copy("a0", "a1"));
    blocks[0]!.successors.push(blocks[1]!);
    blocks[1]!.predecessors.push(blocks[0]!);
    blocks[1]!.instructions.push(
      instruction("use", [use(physical("a1"), 8)]),
      instruction("ret", [use(physical("a0"), 8)], { returns: true }),
    );

    expect(coalesceRoundTrips(fn, convention)).toBe(0);
    expect(opcodes(blocks[0]!)).toEqual(["move", "add", "move"]);
  });

  it("coalesces across instructions that touch neither register", () => {
    const { fn, blocks } = functionOf(["loop", "exit"]);
    blocks[0]!.instructions.push(
      copy("a1", "a0"),
      accumulate("a1", "a2"),
      instruction("step", [def(physical("a3"), 8), use(physical("a3"), 8)], { tied: true }),
      copy("a0", "a1"),
    );
    blocks[0]!.successors.push(blocks[1]!);
    blocks[1]!.predecessors.push(blocks[0]!);
    blocks[1]!.instructions.push(instruction("ret", [use(physical("a0"), 8)], { returns: true }));

    expect(coalesceRoundTrips(fn, convention)).toBe(2);
    expect(opcodes(blocks[0]!)).toEqual(["add", "step"]);
  });

  it("keeps the round trip when something between reads the held register", () => {
    const { fn, blocks } = functionOf(["loop", "exit"]);
    blocks[0]!.instructions.push(
      copy("a1", "a0"),
      accumulate("a1", "a2"),
      instruction("peek", [def(physical("a3"), 8), use(physical("a0"), 8)]),
      copy("a0", "a1"),
    );
    blocks[0]!.successors.push(blocks[1]!);
    blocks[1]!.predecessors.push(blocks[0]!);
    blocks[1]!.instructions.push(instruction("ret", [use(physical("a0"), 8)], { returns: true }));

    expect(coalesceRoundTrips(fn, convention)).toBe(0);
  });

  it("leaves a call between the copies alone", () => {
    const { fn, blocks } = functionOf(["loop", "exit"]);
    blocks[0]!.instructions.push(
      copy("a1", "a0"),
      accumulate("a1", "a2"),
      instruction("call", [use(physical("a3"), 8)], { call: true }),
      copy("a0", "a1"),
    );
    blocks[0]!.successors.push(blocks[1]!);
    blocks[1]!.predecessors.push(blocks[0]!);
    blocks[1]!.instructions.push(instruction("ret", [use(physical("a0"), 8)], { returns: true }));

    expect(coalesceRoundTrips(fn, convention)).toBe(0);
  });
});
