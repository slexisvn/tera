import { describe, expect, it } from "vitest";
import { MachineFunction } from "../../../src/optimizing/machine/ir.js";
import { layoutFrame } from "../../../src/optimizing/machine/frame.js";
import { testTarget } from "./support.js";

const target = testTarget();

describe("frame layout", () => {
  it("packs local slots above the outgoing argument area", () => {
    const fn = new MachineFunction("locals", "locals");
    fn.outgoingBytes = 16;
    const first = fn.createSlot(8, 8);
    const second = fn.createSlot(4, 4);

    const frame = layoutFrame(fn, target, []);
    expect(frame.outgoingBytes).toBe(16);
    expect(first.offset).toBe(16);
    expect(second.offset).toBe(24);
    expect(frame.localBytes).toBe(12);
  });

  it("aligns a slot to its own alignment", () => {
    const fn = new MachineFunction("aligned", "aligned");
    fn.createSlot(4, 4);
    const wide = fn.createSlot(8, 8);

    layoutFrame(fn, target, []);
    expect(wide.offset % 8).toBe(0);
  });

  it("rounds the frame so the stack stays aligned at a call", () => {
    const fn = new MachineFunction("aligned", "aligned");
    fn.createSlot(4, 4);

    const frame = layoutFrame(fn, target, []);
    expect((frame.frameSize + target.abi.entryStackAdjustBytes) % 16).toBe(0);
  });

  it("gives every preserved register its own slot", () => {
    const fn = new MachineFunction("saved", "saved");
    const preserved = target.registers.select(["a2", "a3"]);

    const frame = layoutFrame(fn, target, preserved);
    expect(frame.saved.map((entry) => entry.register.name)).toEqual(["a2", "a3"]);
    expect(frame.saved[1]!.offset - frame.saved[0]!.offset).toBe(8);
  });

  it("reserves the registers the ABI says a caller must preserve itself", () => {
    const fn = new MachineFunction("calls", "calls");
    fn.hasCalls = true;
    const linked = testTarget();
    const withLink = {
      ...linked,
      abi: { ...linked.abi, savedOnCall: linked.registers.select(["a2"]) },
    };

    const frame = layoutFrame(fn, withLink, []);
    expect(frame.saved.map((entry) => entry.register.name)).toEqual(["a2"]);
  });

  it("resolves incoming argument slots above the frame and the return address", () => {
    const fn = new MachineFunction("incoming", "incoming");
    fn.createSlot(8, 8);
    const argument = fn.createIncomingSlot(0, 8);

    const frame = layoutFrame(fn, target, []);
    expect(argument.offset).toBe(frame.frameSize + target.abi.entryStackAdjustBytes);
  });

  it("leaves an empty leaf function without a frame", () => {
    const frame = layoutFrame(new MachineFunction("leaf", "leaf"), target, []);
    expect(frame.frameSize).toBe(0);
  });
});
