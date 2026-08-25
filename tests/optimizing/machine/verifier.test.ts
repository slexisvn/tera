import { describe, expect, it } from "vitest";
import {
  def,
  imm,
  instruction,
  label,
  mem,
  use,
  MachineFunction,
  type MachineBlock,
} from "../../../src/optimizing/machine/ir.js";
import {
  MachineValidationError,
  validateMachineFunction,
} from "../../../src/optimizing/machine/verifier.js";
import type { PhysicalRegister } from "../../../src/optimizing/target/registers.js";

const INT = "gp";
const WORD = 8;

const physical = (name: string, index: number): PhysicalRegister => ({
  kind: "physical",
  index,
  name,
  classId: INT,
});

const RAX = physical("rax", 0);
const RCX = physical("rcx", 1);

function functionWith(build: (fn: MachineFunction, entry: MachineBlock) => void): MachineFunction {
  const fn = new MachineFunction("probe", "probe");
  const entry = fn.createBlock(".Lentry");
  build(fn, entry);
  return fn;
}

function link(from: MachineBlock, to: MachineBlock): void {
  from.successors.push(to);
  to.predecessors.push(from);
}

function errorsOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof MachineValidationError) return error.errors;
    throw error;
  }
  return [];
}

describe("verifying a machine function before register allocation", () => {
  it("accepts a virtual that is defined before it is read", () => {
    const fn = functionWith((built, entry) => {
      const value = built.createVirtual(INT, WORD);
      entry.instructions.push(instruction("mov", [def(value, WORD), imm(1)]));
      entry.instructions.push(instruction("ret", [use(value, WORD)], { terminator: true }));
    });
    expect(validateMachineFunction(fn, "pre-allocation", "selection")).toBe(true);
  });

  it("rejects a virtual read on a path that never defines it", () => {
    const fn = functionWith((built, entry) => {
      const value = built.createVirtual(INT, WORD);
      entry.instructions.push(instruction("ret", [use(value, WORD)], { terminator: true }));
    });
    expect(errorsOf(() => validateMachineFunction(fn, "pre-allocation", "selection"))).toEqual([
      "probe after selection: v0 is read on a path that never defines it",
    ]);
  });

  it("accepts a definition that reaches the use through a predecessor", () => {
    const fn = functionWith((built, entry) => {
      const value = built.createVirtual(INT, WORD);
      const tail = built.createBlock(".Ltail");
      link(entry, tail);
      entry.instructions.push(instruction("mov", [def(value, WORD), imm(1)]));
      entry.instructions.push(instruction("jmp", [label(tail)], { terminator: true }));
      tail.instructions.push(instruction("ret", [use(value, WORD)], { terminator: true }));
    });
    expect(validateMachineFunction(fn, "pre-allocation", "selection")).toBe(true);
  });

  it("rejects a definition that reaches only one of two incoming paths", () => {
    const fn = functionWith((built, entry) => {
      const value = built.createVirtual(INT, WORD);
      const defining = built.createBlock(".Ldefining");
      const bare = built.createBlock(".Lbare");
      const join = built.createBlock(".Ljoin");
      link(entry, defining);
      link(entry, bare);
      link(defining, join);
      link(bare, join);
      entry.instructions.push(
        instruction("jcc", [label(defining), label(bare)], { terminator: true }),
      );
      defining.instructions.push(instruction("mov", [def(value, WORD), imm(1)]));
      defining.instructions.push(instruction("jmp", [label(join)], { terminator: true }));
      bare.instructions.push(instruction("jmp", [label(join)], { terminator: true }));
      join.instructions.push(instruction("ret", [use(value, WORD)], { terminator: true }));
    });
    expect(errorsOf(() => validateMachineFunction(fn, "pre-allocation", "selection"))).toEqual([
      "probe after selection: v0 is read on a path that never defines it",
    ]);
  });

  it("rejects a virtual read wider than it was created", () => {
    const fn = functionWith((built, entry) => {
      const narrow = built.createVirtual(INT, 4);
      entry.instructions.push(instruction("mov", [def(narrow, 4), imm(1)]));
      entry.instructions.push(instruction("ret", [use(narrow, 8)], { terminator: true }));
    });
    expect(errorsOf(() => validateMachineFunction(fn, "pre-allocation", "selection"))).toEqual([
      "probe after selection: .Lentry:ret uses v0 at 8 bytes but it only holds 4",
    ]);
  });

  it("accepts a sub-register view of a wider virtual", () => {
    const fn = functionWith((built, entry) => {
      const wide = built.createVirtual(INT, 4);
      entry.instructions.push(instruction("sete", [def(wide, 1)]));
      entry.instructions.push(instruction("movzbl", [def(wide, 4), use(wide, 1)]));
      entry.instructions.push(instruction("ret", [use(wide, 4)], { terminator: true }));
    });
    expect(validateMachineFunction(fn, "pre-allocation", "selection")).toBe(true);
  });
});

describe("verifying machine control flow and frame references", () => {
  it("rejects a successor edge with no matching predecessor edge", () => {
    const fn = functionWith((built, entry) => {
      const tail = built.createBlock(".Ltail");
      entry.successors.push(tail);
      entry.instructions.push(instruction("jmp", [label(tail)], { terminator: true }));
      tail.instructions.push(instruction("ret", [], { terminator: true }));
    });
    expect(errorsOf(() => validateMachineFunction(fn, "pre-allocation", "selection"))).toEqual([
      "probe after selection: .Lentry -> .Ltail has no matching predecessor edge",
    ]);
  });

  it("rejects a branch to a block the function does not own", () => {
    const stranger = new MachineFunction("other", "other").createBlock(".Lstranger");
    const fn = functionWith((_built, entry) => {
      entry.instructions.push(instruction("jmp", [label(stranger)], { terminator: true }));
    });
    expect(errorsOf(() => validateMachineFunction(fn, "pre-allocation", "selection"))).toEqual([
      "probe after selection: .Lentry:jmp branches to unknown block .Lstranger",
    ]);
  });

  it("rejects a memory operand naming a stack slot from another frame", () => {
    const foreign = new MachineFunction("other", "other").createSlot(WORD, WORD);
    const fn = functionWith((_built, entry) => {
      entry.instructions.push(
        instruction("mov", [def(RAX, WORD), mem(WORD, { slot: foreign })], { terminator: true }),
      );
    });
    expect(errorsOf(() => validateMachineFunction(fn, "pre-allocation", "selection"))).toEqual([
      "probe after selection: .Lentry:mov addresses stack slot 0 the frame does not own",
    ]);
  });
});

describe("verifying a machine function after register allocation", () => {
  it("rejects a virtual that survived allocation", () => {
    const fn = functionWith((built, entry) => {
      const value = built.createVirtual(INT, WORD);
      entry.instructions.push(instruction("mov", [def(value, WORD), imm(1)]));
      entry.instructions.push(instruction("ret", [use(value, WORD)], { terminator: true }));
    });
    expect(errorsOf(() => validateMachineFunction(fn, "post-allocation", "allocation"))).toEqual([
      "probe after allocation: .Lentry:mov still holds v0 after allocation",
      "probe after allocation: .Lentry:ret still holds v0 after allocation",
    ]);
  });

  it("rejects tied operands that ended up in different registers", () => {
    const fn = functionWith((_built, entry) => {
      entry.instructions.push(
        instruction("sub", [def(RAX, WORD), use(RCX, WORD), imm(1)], { tied: true }),
      );
    });
    expect(errorsOf(() => validateMachineFunction(fn, "post-allocation", "allocation"))).toEqual([
      "probe after allocation: .Lentry:sub is tied but its operands hold different registers",
    ]);
  });

  it("accepts tied operands that name the same register through distinct objects", () => {
    const fn = functionWith((_built, entry) => {
      entry.instructions.push(
        instruction("sub", [def(RAX, WORD), use({ ...RAX }, WORD), imm(1)], { tied: true }),
      );
    });
    expect(validateMachineFunction(fn, "post-allocation", "allocation")).toBe(true);
  });

  it("rejects a tied instruction that is not in destructive form", () => {
    const fn = functionWith((_built, entry) => {
      entry.instructions.push(instruction("sub", [def(RAX, WORD), imm(1)], { tied: true }));
    });
    expect(errorsOf(() => validateMachineFunction(fn, "post-allocation", "allocation"))).toEqual([
      "probe after allocation: .Lentry:sub is tied but is not in destructive form",
    ]);
  });
});
