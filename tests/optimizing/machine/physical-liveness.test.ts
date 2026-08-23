import { describe, expect, it } from "vitest";
import {
  def,
  instruction,
  use,
  MachineFunction,
  type MachineBlock,
} from "../../../src/optimizing/machine/ir.js";
import { physicalLiveness } from "../../../src/optimizing/machine/physical-liveness.js";
import { testLowering, testTarget } from "./support.js";

const lowering = testLowering(testTarget());
const convention = lowering.target.abi.callingConvention;

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

function edge(from: MachineBlock, to: MachineBlock): void {
  from.successors.push(to);
  to.predecessors.push(from);
}

describe("physicalLiveness", () => {
  it("reports a register dead once nothing reads it again", () => {
    const { fn, blocks } = functionOf(["only"]);
    blocks[0]!.instructions.push(
      instruction("load", [def(physical("a1"), 8)]),
      instruction("ret", [use(physical("a0"), 8)], { returns: true }),
    );

    const liveness = physicalLiveness(fn, convention);
    expect(liveness.liveAfter(blocks[0]!, 0, "a1")).toBe(false);
  });

  it("keeps the register a return answers with alive", () => {
    const { fn, blocks } = functionOf(["only"]);
    const answered = [...convention.returnRegisters.values()][0]!.name;
    blocks[0]!.instructions.push(
      instruction("load", [def(physical(answered), 8)]),
      instruction("ret", [], { returns: true }),
    );

    expect(physicalLiveness(fn, convention).liveAfter(blocks[0]!, 0, answered)).toBe(true);
  });

  it("carries liveness backwards across a loop", () => {
    const { fn, blocks } = functionOf(["entry", "body", "exit"]);
    const [entry, body, exit] = blocks as [MachineBlock, MachineBlock, MachineBlock];
    edge(entry, body);
    edge(body, body);
    edge(body, exit);
    entry.instructions.push(instruction("load", [def(physical("a1"), 8)]));
    body.instructions.push(
      instruction("step", [def(physical("a2"), 8), use(physical("a1"), 8)]),
    );
    exit.instructions.push(instruction("ret", [use(physical("a0"), 8)], { returns: true }));

    const liveness = physicalLiveness(fn, convention);
    expect(liveness.liveAfter(entry, 0, "a1")).toBe(true);
    expect(liveness.liveAfter(body, 0, "a2")).toBe(false);
  });

  it("treats everything as live across a call", () => {
    const { fn, blocks } = functionOf(["only"]);
    blocks[0]!.instructions.push(
      instruction("load", [def(physical("a1"), 8)]),
      instruction("call", [], { call: true }),
      instruction("ret", [use(physical("a0"), 8)], { returns: true }),
    );

    expect(physicalLiveness(fn, convention).liveAfter(blocks[0]!, 0, "a1")).toBe(true);
  });
});
