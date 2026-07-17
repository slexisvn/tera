import { describe, it, expect } from "vitest";
import { DeoptSignal } from "../../src/deopt/signal.js";

describe("DeoptSignal", () => {
  it("toString formats frameStateId, reason, and bytecodeOffset", () => {
    const signal = new DeoptSignal("smi-check-failed", 42, [], [], 3, new Map());
    expect(signal.toString()).toBe(
      'DeoptSignal(fs=3, reason="smi-check-failed", bc=42)',
    );
  });

  it("toString with default frameStateId shows -1", () => {
    const signal = new DeoptSignal("overflow", 10, [], []);
    expect(signal.toString()).toContain("fs=-1");
  });
});
