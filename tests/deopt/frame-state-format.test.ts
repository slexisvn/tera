import { describe, it, expect } from "vitest";
import { FrameState, FrameStateBuilder } from "../../src/deopt/frame-state.js";
import { mkSmi, mkString, mkNull, mkBool } from "../../src/core/value/index.js";

describe("FrameState.toString", () => {
  it("formats locals with slot names from compiledFunction", () => {
    const fn = { name: "add", localNames: { 0: "a", 1: "b" } };
    const fs = new FrameState(fn, 10);
    fs.id = 0;
    fs.setLocal(0, { id: 1, type: "Add" });
    fs.setLocal(1, { id: 2, type: "Const" });
    const str = fs.toString();
    expect(str).toContain("fn=add");
    expect(str).toContain("pc=10");
    expect(str).toContain("a=v1");
    expect(str).toContain("b=v2");
  });

  it("uses L<slot> when no localNames available", () => {
    const fn = { name: "noNames" };
    const fs = new FrameState(fn, 0);
    fs.id = 1;
    fs.setLocal(3, { id: 5, type: "X" });
    const str = fs.toString();
    expect(str).toContain("L3=v5");
  });

  it("formats tagged number values correctly", () => {
    const fn = { name: "nums" };
    const fs = new FrameState(fn, 0);
    fs.id = 2;
    fs.setLocal(0, mkSmi(42));
    fs.pushStack(mkNull());
    const str = fs.toString();
    expect(str).toContain("42");
    expect(str).toContain("null");
  });

  it("formats string values with quotes", () => {
    const fn = { name: "strs" };
    const fs = new FrameState(fn, 0);
    fs.id = 0;
    fs.setLocal(0, mkString("hello"));
    const str = fs.toString();
    expect(str).toContain('"hello"');
  });

  it("includes caller reference for inlined frames", () => {
    const callerFs = new FrameState({ name: "caller" }, 0);
    callerFs.id = 5;
    const calleeFs = new FrameState({ name: "callee" }, 10);
    calleeFs.id = 6;
    calleeFs.setCallerFrame(callerFs);
    const str = calleeFs.toString();
    expect(str).toContain("caller=fs#5");
  });

  it("includes [safepoint] when marked", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    fs.id = 0;
    fs.markAsSafepoint();
    expect(fs.toString()).toContain("[safepoint]");
  });

  it("formats null/undefined IR values as 'null'", () => {
    const fn = { name: "fn" };
    const fs = new FrameState(fn, 0);
    fs.id = 0;
    fs.setLocal(0, null);
    fs.pushStack(undefined);
    const str = fs.toString();
    expect(str).toContain("null");
  });

  it("sorts locals by slot number", () => {
    const fn = { name: "sorted" };
    const fs = new FrameState(fn, 0);
    fs.id = 0;
    fs.setLocal(5, { id: 50, type: "X" });
    fs.setLocal(1, { id: 10, type: "X" });
    fs.setLocal(3, { id: 30, type: "X" });
    const str = fs.toString();
    const l1Pos = str.indexOf("v10");
    const l3Pos = str.indexOf("v30");
    const l5Pos = str.indexOf("v50");
    expect(l1Pos).toBeLessThan(l3Pos);
    expect(l3Pos).toBeLessThan(l5Pos);
  });
});

describe("FrameState.setBytecodeOffset", () => {
  it("updates bytecodeOffset used by toCompact and matches", () => {
    const fn = { name: "fn" };
    const fs = new FrameState(fn, 10);
    fs.setBytecodeOffset(99);
    expect(fs.bytecodeOffset).toBe(99);
    expect(fs.toCompact()).toContain("bc:99");

    const other = new FrameState(fn, 99);
    expect(fs.matches(other)).toBe(true);
  });
});

describe("FrameState.matches edge cases", () => {
  it("returns false for different compiledFunction references", () => {
    const fn1 = { name: "fn" };
    const fn2 = { name: "fn" };
    const a = new FrameState(fn1, 0);
    const b = new FrameState(fn2, 0);
    expect(a.matches(b)).toBe(false);
  });

  it("returns false when other has extra local not in this", () => {
    const fn = { name: "fn" };
    const a = new FrameState(fn, 0);
    a.setLocal(0, "x");
    const b = new FrameState(fn, 0);
    b.setLocal(0, "x");
    b.setLocal(1, "y");
    expect(a.matches(b)).toBe(false);
  });

  it("returns true for two empty frame states with same function and offset", () => {
    const fn = { name: "fn" };
    const a = new FrameState(fn, 5);
    const b = new FrameState(fn, 5);
    expect(a.matches(b)).toBe(true);
  });
});

describe("FrameState.getLocalsArray edge cases", () => {
  it("returns empty array when no locals set", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    expect(fs.getLocalsArray()).toEqual([]);
  });

  it("handles single local at slot 0", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    fs.setLocal(0, "only");
    expect(fs.getLocalsArray()).toEqual(["only"]);
  });
});

describe("FrameStateBuilder.dump", () => {
  it("outputs header and compact form of each state", () => {
    const builder = new FrameStateBuilder();
    builder.capture({ name: "alpha" }, 5, new Map([[0, "a"]]), [], null, null);
    builder.capture({ name: "beta" }, 10, [], ["s"], null, null);
    const dump = builder.dump();
    expect(dump).toContain("FrameStates (2):");
    expect(dump).toContain("alpha");
    expect(dump).toContain("bc:5");
    expect(dump).toContain("beta");
    expect(dump).toContain("bc:10");
  });

  it("outputs inlined and safepoint markers", () => {
    const builder = new FrameStateBuilder();
    const caller = builder.capture({ name: "outer" }, 0, [], [], null, null);
    const callee = builder.capture({ name: "inner" }, 5, [], [], null, caller);
    caller.markAsSafepoint();
    const dump = builder.dump();
    expect(dump).toContain("[inlined]");
    expect(dump).toContain("[safepoint]");
  });

  it("empty builder outputs count 0", () => {
    const builder = new FrameStateBuilder();
    expect(builder.dump()).toContain("FrameStates (0):");
  });
});

describe("FrameState.clone preserves all fields", () => {
  it("preserves safepoint and inlined state through clone", () => {
    const caller = new FrameState({ name: "caller" }, 0);
    caller.id = 0;
    const fs = new FrameState({ name: "fn" }, 10);
    fs.id = 1;
    fs.setCallerFrame(caller);
    fs.markAsSafepoint();

    const cloned = fs.clone();
    expect(cloned.isInlinedFrame).toBe(true);
    expect(cloned.safepoint).toBe(true);
    expect(cloned.callerFrameState).toBe(caller);
    expect(cloned.bytecodeOffset).toBe(10);
  });

  it("clone with null sunkAllocations keeps null", () => {
    const fs = new FrameState({ name: "fn" }, 0);
    const cloned = fs.clone();
    expect(cloned.sunkAllocations).toBe(null);
  });
});
