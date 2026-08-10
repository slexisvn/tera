import { describe, expect, it } from "vitest";
import {
  argumentLocations,
  outgoingArgumentBytes,
  type CallingConvention,
} from "../../../src/optimizing/target/abi.js";
import { RegisterFile } from "../../../src/optimizing/target/registers.js";
import { x64Abi } from "../../../src/optimizing/backends/x64/abi.js";
import { X64_FPR, X64_GPR } from "../../../src/optimizing/backends/x64/registers.js";
import { riscvAbi } from "../../../src/optimizing/backends/riscv64/abi.js";
import {
  RISCV_FPR,
  RISCV_GPR,
} from "../../../src/optimizing/backends/riscv64/registers.js";

function namesOf(
  convention: CallingConvention,
  classes: readonly string[],
): Array<string | number> {
  return argumentLocations(convention, classes).map((location) =>
    location.kind === "register" ? location.register.name : location.offset,
  );
}

describe("SysV x86-64", () => {
  const { abi } = x64Abi("sysv");

  it("fills integer and float argument registers from independent pools", () => {
    expect(
      namesOf(abi.callingConvention, [X64_GPR, X64_FPR, X64_GPR, X64_FPR]),
    ).toEqual(["rdi", "xmm0", "rsi", "xmm1"]);
  });

  it("spills the seventh integer argument to the stack with no shadow space", () => {
    const classes = Array.from({ length: 8 }, () => X64_GPR);
    expect(namesOf(abi.callingConvention, classes)).toEqual([
      "rdi", "rsi", "rdx", "rcx", "r8", "r9", 0, 8,
    ]);
  });

  it("reserves no outgoing bytes for a register only call", () => {
    const locations = argumentLocations(abi.callingConvention, [X64_GPR, X64_GPR]);
    expect(outgoingArgumentBytes(abi.callingConvention, locations)).toBe(0);
  });
});

describe("Win64", () => {
  const { abi } = x64Abi("win64");

  it("shares one argument position across integer and float registers", () => {
    expect(
      namesOf(abi.callingConvention, [X64_GPR, X64_FPR, X64_GPR, X64_FPR]),
    ).toEqual(["rcx", "xmm1", "r8", "xmm3"]);
  });

  it("places the fifth argument above the shadow space", () => {
    const classes = Array.from({ length: 6 }, () => X64_GPR);
    expect(namesOf(abi.callingConvention, classes)).toEqual([
      "rcx", "rdx", "r8", "r9", 32, 40,
    ]);
  });

  it("always reserves shadow space for a call", () => {
    const locations = argumentLocations(abi.callingConvention, [X64_GPR]);
    expect(outgoingArgumentBytes(abi.callingConvention, locations)).toBe(32);
  });

  it("treats rsi, rdi and the upper xmm registers as callee saved", () => {
    const preserved = abi.callingConvention.calleeSaved.map((register) => register.name);
    expect(preserved).toContain("rsi");
    expect(preserved).toContain("rdi");
    expect(preserved).toContain("xmm6");
    expect(preserved).not.toContain("xmm5");
  });
});

describe("RISC-V lp64d", () => {
  const { abi } = riscvAbi();

  it("uses eight integer and eight float argument registers", () => {
    const classes = [
      ...Array.from({ length: 9 }, () => RISCV_GPR),
      RISCV_FPR,
    ];
    expect(namesOf(abi.callingConvention, classes)).toEqual([
      "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", 0, "fa0",
    ]);
  });

  it("saves the return address itself when the function calls", () => {
    expect(abi.savedOnCall.map((register) => register.name)).toEqual(["ra"]);
  });

  it("has no return address pushed by the call instruction", () => {
    expect(abi.entryStackAdjustBytes).toBe(0);
  });
});

describe("RegisterFile", () => {
  const file = new RegisterFile([
    {
      id: "gpr",
      width: 8,
      saveBytes: 8,
      allocation: ["r0", "r1"],
      scratch: ["r2"],
      reserved: ["sp"],
    },
  ]);

  it("assigns dense indices across every declared register", () => {
    expect(file.registers.map((register) => register.index)).toEqual([0, 1, 2, 3]);
    expect(file.size).toBe(4);
  });

  it("keeps reserved registers out of the allocation order", () => {
    const gpr = file.classOf("gpr");
    expect(gpr.allocation.map((register) => register.name)).toEqual(["r0", "r1"]);
    expect(gpr.members.map((register) => register.name)).toEqual(["r0", "r1", "r2", "sp"]);
  });

  it("rejects an unknown register by name", () => {
    expect(() => file.register("nope")).toThrow(/no physical register named nope/);
  });
});
