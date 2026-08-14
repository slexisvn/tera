import { describe, expect, it } from "vitest";
import {
  MachineFunction,
  instruction,
  label,
  type MachineBlock,
} from "../../../src/optimizing/machine/ir.js";
import { assembleFunction } from "../../../src/optimizing/mc/assembler.js";
import { layoutModule } from "../../../src/optimizing/mc/layout.js";
import { McModule } from "../../../src/optimizing/mc/module.js";
import type { McInstructionFragment } from "../../../src/optimizing/mc/fragment.js";
import { x64McTarget } from "../../../src/optimizing/backends/x64/mc/target.js";

function padded(block: MachineBlock, count: number): void {
  for (let index = 0; index < count; index++) {
    block.instructions.push(instruction("nop", []));
  }
}

function jumpOver(fillerBytes: number): {
  module: McModule;
  branch: McInstructionFragment;
} {
  const fn = new MachineFunction("probe", "probe");
  const start = fn.createBlock(".Lprobe_start");
  const middle = fn.createBlock(".Lprobe_middle");
  const landing = fn.createBlock(".Lprobe_landing");
  start.instructions.push(instruction("jmp", [label(landing)], { terminator: true }));
  padded(middle, fillerBytes);
  landing.instructions.push(instruction("ret", []));

  const module = new McModule();
  const assembled = assembleFunction(module, x64McTarget, fn);
  layoutModule(module, x64McTarget);
  const branch = assembled.section.fragments.find(
    (fragment) => fragment.kind === "instruction" && fragment.node.opcode === "jmp",
  ) as McInstructionFragment;
  return { module, branch };
}

function displacementOf(branch: McInstructionFragment): number {
  const bytes = branch.bytes;
  if (bytes.length === 2) return (bytes[1]! << 24) >> 24;
  let value = 0;
  for (let index = 4; index >= 1; index--) value = (value << 8) | bytes[index]!;
  return value | 0;
}

describe("machine code layout", () => {
  it("keeps a nearby forward jump in the short form", () => {
    const { branch } = jumpOver(100);

    expect(branch.form).toBe(0);
    expect(branch.size).toBe(2);
  });

  it("widens a forward jump that no longer reaches with a byte displacement", () => {
    const { branch } = jumpOver(200);

    expect(branch.form).toBe(1);
    expect(branch.size).toBe(5);
  });

  it("resolves the displacement against the end of the branch", () => {
    const { module, branch } = jumpOver(200);
    const landing = module.symbols.addressOf(".Lprobe_landing")!;

    expect(displacementOf(branch)).toBe(landing - (branch.address + branch.size));
  });

  it("relaxes only once for a jump that crosses the byte boundary", () => {
    const fn = new MachineFunction("edge", "edge");
    const start = fn.createBlock(".Ledge_start");
    const middle = fn.createBlock(".Ledge_middle");
    const landing = fn.createBlock(".Ledge_landing");
    start.instructions.push(instruction("jmp", [label(landing)], { terminator: true }));
    padded(middle, 128);
    landing.instructions.push(instruction("ret", []));

    const module = new McModule();
    assembleFunction(module, x64McTarget, fn);
    const result = layoutModule(module, x64McTarget);

    expect(result.relaxations).toBe(1);
    expect(result.passes).toBe(2);
  });

  it("resolves a backward branch to a negative displacement", () => {
    const fn = new MachineFunction("loop", "loop");
    const header = fn.createBlock(".Lloop_header");
    const latch = fn.createBlock(".Lloop_latch");
    header.instructions.push(instruction("nop", []));
    latch.instructions.push(instruction("jmp", [label(header)], { terminator: true }));

    const module = new McModule();
    const assembled = assembleFunction(module, x64McTarget, fn);
    layoutModule(module, x64McTarget);
    const branch = assembled.section.fragments.find(
      (fragment) => fragment.kind === "instruction" && fragment.node.opcode === "jmp",
    ) as McInstructionFragment;

    expect(displacementOf(branch)).toBe(-3);
  });

  it("records a relocation for a symbol it cannot resolve", () => {
    const fn = new MachineFunction("caller", "caller");
    const entry = fn.createBlock(".Lcaller_entry");
    entry.instructions.push(
      instruction("call", [{ kind: "symbol", name: "external_helper" }], {
        call: true,
        implicitFrom: 1,
      }),
    );

    const module = new McModule();
    assembleFunction(module, x64McTarget, fn);
    layoutModule(module, x64McTarget);

    expect(module.relocations).toHaveLength(1);
    expect(module.relocations[0]!.symbol).toBe("external_helper");
    expect(module.relocations[0]!.offset).toBe(1);
  });

  it("aligns each function to the target requirement", () => {
    const module = new McModule();
    const first = new MachineFunction("one", "one");
    first.createBlock(".Lone_entry").instructions.push(instruction("ret", []));
    const second = new MachineFunction("two", "two");
    second.createBlock(".Ltwo_entry").instructions.push(instruction("ret", []));

    assembleFunction(module, x64McTarget, first);
    assembleFunction(module, x64McTarget, second);
    layoutModule(module, x64McTarget);

    expect(module.symbols.addressOf("one")).toBe(0);
    expect(module.symbols.addressOf("two")).toBe(16);
  });
});
