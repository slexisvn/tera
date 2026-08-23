import { describe, expect, it } from "vitest";
import {
  cfiDirectives,
  describeSteps,
  sleb128,
  uleb128,
  type PrologueEffect,
} from "../../../../src/optimizing/mc/dwarf/eh-frame.js";
import { x64CfiTarget } from "../../../../src/optimizing/backends/x64/unwind.js";
import { riscvCfiTarget } from "../../../../src/optimizing/backends/riscv64/unwind.js";

const allocate = (bytes: number): PrologueEffect => ({ kind: "allocate", bytes });
const save = (register: string, offset: number): PrologueEffect => ({
  kind: "save",
  register,
  offset,
});

describe("leb128", () => {
  it("encodes unsigned values in seven-bit digits", () => {
    expect(uleb128(0)).toEqual([0]);
    expect(uleb128(127)).toEqual([127]);
    expect(uleb128(128)).toEqual([0x80, 0x01]);
    expect(uleb128(624485)).toEqual([0xe5, 0x8e, 0x26]);
  });

  it("encodes signed values with a sign-extended final digit", () => {
    expect(sleb128(0)).toEqual([0]);
    expect(sleb128(-8)).toEqual([0x78]);
    expect(sleb128(-64)).toEqual([0x40]);
    expect(sleb128(-65)).toEqual([0xbf, 0x7f]);
    expect(sleb128(63)).toEqual([63]);
    expect(sleb128(64)).toEqual([0xc0, 0x00]);
  });
});

describe("describeSteps", () => {
  it("counts the return address pushed by a call into the x64 frame", () => {
    expect(describeSteps([allocate(40)], x64CfiTarget)).toEqual([{ kind: "cfa", offset: 48 }]);
  });

  it("places a saved register below the canonical frame address", () => {
    const described = describeSteps([allocate(40), save("rbx", 0), save("r14", 24)], x64CfiTarget);

    expect(described).toEqual([
      { kind: "cfa", offset: 48 },
      { kind: "saved", register: 3, slots: 6 },
      { kind: "saved", register: 14, slots: 3 },
    ]);
  });

  it("keeps the return address in a register on riscv", () => {
    const described = describeSteps([allocate(32), save("ra", 24)], riscvCfiTarget);

    expect(described).toEqual([
      { kind: "cfa", offset: 32 },
      { kind: "saved", register: 1, slots: 1 },
    ]);
  });

  it("numbers riscv float registers above the integer file", () => {
    const described = describeSteps([allocate(16), save("fs2", 0)], riscvCfiTarget);

    expect(described).toEqual([
      { kind: "cfa", offset: 16 },
      { kind: "saved", register: 50, slots: 2 },
    ]);
  });

  it("measures every save against the frame the prologue has built so far", () => {
    expect(describeSteps([save("rbx", 0)], x64CfiTarget)).toEqual([
      { kind: "saved", register: 3, slots: 1 },
    ]);
    expect(describeSteps([allocate(8), save("rbx", 16)], x64CfiTarget)).toBeNull();
  });

  it("refuses a register it cannot name", () => {
    expect(describeSteps([allocate(16), save("xmm3", 0)], x64CfiTarget)).toBeNull();
  });
});

describe("cfiDirectives", () => {
  it("prints one directive per prologue instruction", () => {
    expect(cfiDirectives([allocate(40), save("rbx", 0)], x64CfiTarget)).toEqual([
      ["\t.cfi_def_cfa_offset 48"],
      ["\t.cfi_offset 3, -48"],
    ]);
  });

  it("answers nothing when a step cannot be described", () => {
    expect(cfiDirectives([allocate(16), save("xmm3", 0)], x64CfiTarget)).toBeNull();
  });
});
