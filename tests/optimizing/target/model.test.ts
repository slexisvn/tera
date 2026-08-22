import { describe, expect, it } from "vitest";
import {
  defaultMachineReprOf,
  isMachineTarget,
  type MachineTargetModel,
  type TargetModel,
} from "../../../src/optimizing/target/model.js";
import {
  REP_BOOL,
  REP_FLOAT64,
  REP_HANDLE,
  REP_INT32,
  REP_TAGGED,
  REP_TAGGED_NUMBER,
  type Representation,
} from "../../../src/optimizing/types/representation.js";
import type { RuntimeAbi } from "../../../src/optimizing/target/abi.js";

const REPRESENTATIONS: readonly Representation[] = [
  REP_INT32,
  REP_FLOAT64,
  REP_TAGGED_NUMBER,
  REP_HANDLE,
  REP_TAGGED,
  REP_BOOL,
];

const FALLBACK = defaultMachineReprOf("not-a-representation" as Representation);

function targetOf(abi: RuntimeAbi | null, extra: object = {}): TargetModel {
  return {
    name: "probe",
    capabilities: new Set(),
    speculation: { allows: () => false },
    abi,
    machineReprOf: defaultMachineReprOf,
    ...extra,
  } as unknown as TargetModel;
}

describe("choosing a machine representation for an IR representation", () => {
  it("gives every representation the IR can carry a machine representation of its own", () => {
    for (const rep of REPRESENTATIONS) {
      expect(typeof defaultMachineReprOf(rep)).toBe("string");
    }
  });

  it("keeps an int32 in an integer register class", () => {
    expect(defaultMachineReprOf(REP_INT32)).toBe("int32");
  });

  it("keeps a boolean apart from an int32, which the C backend spells differently", () => {
    expect(defaultMachineReprOf(REP_BOOL)).not.toBe(defaultMachineReprOf(REP_INT32));
  });

  it("lowers a tagged number to the same machine representation as a plain float", () => {
    expect(defaultMachineReprOf(REP_TAGGED_NUMBER)).toBe(defaultMachineReprOf(REP_FLOAT64));
  });

  it("keeps a fully tagged value apart from a handle, which needs no unboxing", () => {
    expect(defaultMachineReprOf(REP_TAGGED)).not.toBe(defaultMachineReprOf(REP_HANDLE));
  });

  it("falls back to a pointer for a representation it has never been told about", () => {
    expect(FALLBACK).toBe("pointer");
  });

  it("never falls back for a representation the IR actually produces", () => {
    const mapped = REPRESENTATIONS.filter((rep) => defaultMachineReprOf(rep) === FALLBACK);

    expect(mapped).toEqual([REP_HANDLE]);
  });
});

describe("telling a machine target from one that only emits source", () => {
  const abi = { returnRegister: "rax" } as unknown as RuntimeAbi;
  const registers = { classes: [] };

  it("rejects a target with no ABI at all", () => {
    expect(isMachineTarget(targetOf(null))).toBe(false);
  });

  it("rejects a target that has an ABI but no register file", () => {
    expect(isMachineTarget(targetOf(abi))).toBe(false);
  });

  it("rejects a target that has a register file but no ABI", () => {
    expect(isMachineTarget(targetOf(null, { registers }))).toBe(false);
  });

  it("accepts a target that carries both an ABI and a register file", () => {
    const target = targetOf(abi, { registers });

    expect(isMachineTarget(target)).toBe(true);
    expect((target as MachineTargetModel).registers).toBe(registers);
  });
});
