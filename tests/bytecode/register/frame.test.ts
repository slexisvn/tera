import { describe, it, expect } from "vitest";
import { RegisterFrame, TDZ_UNINITIALIZED, isTDZUninitialized, throwIfTDZ } from "../../../src/bytecode/register/interpreter/frame.js";
import { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";
import { mkSmi, mkUndefined, getPayload } from "../../../src/core/value/index.js";

function makeCompiledFn(opts = {}) {
  const fn = new RegisterCompiledFunction(opts.name || "test", opts.paramCount || 0);
  fn.registerCount = opts.registerCount || 4;
  if (opts.uninitSlots) {
    for (const s of opts.uninitSlots) fn.uninitializedLocalSlots.add(s);
  }
  return fn;
}

describe("TDZ helpers", () => {
  it("isTDZUninitialized identifies the sentinel", () => {
    expect(isTDZUninitialized(TDZ_UNINITIALIZED)).toBe(true);
    expect(isTDZUninitialized(mkUndefined())).toBe(false);
    expect(isTDZUninitialized(null)).toBe(false);
  });

  it("throwIfTDZ throws for uninitialized, passes through otherwise", () => {
    expect(() => throwIfTDZ(TDZ_UNINITIALIZED, "x")).toThrow("Cannot access 'x' before initialization");
    const val = mkSmi(42);
    expect(throwIfTDZ(val, "y")).toBe(val);
  });
});

describe("RegisterFrame", () => {
  it("initializes registers to undefined, copies args into param slots", () => {
    const fn = makeCompiledFn({ paramCount: 2, registerCount: 4 });
    const args = [mkSmi(10), mkSmi(20)];
    const frame = new RegisterFrame(fn, args, null, null);

    expect(frame.registers).toHaveLength(4);
    expect(frame.registers[0]).toBe(args[0]);
    expect(frame.registers[1]).toBe(args[1]);
    expect(getPayload(frame.registers[2])).toBeUndefined();
  });

  it("marks uninitializedLocalSlots with TDZ sentinel", () => {
    const fn = makeCompiledFn({ registerCount: 3, uninitSlots: [1, 2] });
    const frame = new RegisterFrame(fn, [], null, null);

    expect(isTDZUninitialized(frame.registers[1])).toBe(true);
    expect(isTDZUninitialized(frame.registers[2])).toBe(true);
    expect(isTDZUninitialized(frame.registers[0])).toBe(false);
  });

  it("getReg throws on TDZ-uninitialized slot", () => {
    const fn = makeCompiledFn({ registerCount: 2, uninitSlots: [0] });
    fn.localNames = ["myVar", "ok"];
    const frame = new RegisterFrame(fn, [], null, null);

    expect(() => frame.getReg(0)).toThrow("Cannot access 'myVar' before initialization");
  });

  it("setReg / getReg round-trip for normal registers", () => {
    const fn = makeCompiledFn({ registerCount: 2 });
    const frame = new RegisterFrame(fn, [], null, null);
    const val = mkSmi(99);
    frame.setReg(0, val);
    expect(frame.getReg(0)).toBe(val);
  });

  describe("upvalue cells", () => {
    it("getOrCreateUpvalueCell creates cell, getReg/setReg use it", () => {
      const fn = makeCompiledFn({ registerCount: 2 });
      const frame = new RegisterFrame(fn, [], null, null);
      frame.setReg(0, mkSmi(5));

      const cell = frame.getOrCreateUpvalueCell(0);
      expect(getPayload(cell.get())).toBe(5);

      frame.setReg(0, mkSmi(10));
      expect(getPayload(cell.get())).toBe(10);

      cell.set(mkSmi(20));
      expect(getPayload(frame.getReg(0))).toBe(20);
    });

    it("getOrCreateUpvalueCell returns same cell for same slot", () => {
      const fn = makeCompiledFn({ registerCount: 2 });
      const frame = new RegisterFrame(fn, [], null, null);
      const c1 = frame.getOrCreateUpvalueCell(0);
      const c2 = frame.getOrCreateUpvalueCell(0);
      expect(c1).toBe(c2);
    });

    it("closeUpvalues captures values and detaches from frame", () => {
      const fn = makeCompiledFn({ registerCount: 2 });
      const frame = new RegisterFrame(fn, [], null, null);
      frame.setReg(0, mkSmi(42));
      const cell = frame.getOrCreateUpvalueCell(0);

      frame.closeUpvalues();

      expect(getPayload(cell.get())).toBe(42);
      cell.set(mkSmi(100));
      expect(getPayload(cell.get())).toBe(100);
    });
  });

  it("stores thisValue and originalArgs", () => {
    const fn = makeCompiledFn({ paramCount: 1, registerCount: 2 });
    const thisVal = mkSmi(1);
    const args = [mkSmi(2)];
    const frame = new RegisterFrame(fn, args, thisVal, null);

    expect(frame.thisValue).toBe(thisVal);
    expect(frame.originalArgs).toEqual(args);
  });

  describe("lazy exception handlers", () => {
    it("exceptionHandlers is null on fresh frame", () => {
      const fn = makeCompiledFn({ registerCount: 2 });
      const frame = new RegisterFrame(fn, [], null, null);
      expect(frame.exceptionHandlers).toBeNull();
    });

    it("exceptionHandlers can be lazily initialized and used", () => {
      const fn = makeCompiledFn({ registerCount: 2 });
      const frame = new RegisterFrame(fn, [], null, null);
      frame.exceptionHandlers = [];
      frame.exceptionHandlers.push({ catchPC: 10 });
      expect(frame.exceptionHandlers).toHaveLength(1);
      expect(frame.exceptionHandlers[0].catchPC).toBe(10);
    });
  });

  describe("originalArgs reference sharing", () => {
    it("originalArgs references the same array passed in", () => {
      const fn = makeCompiledFn({ paramCount: 2, registerCount: 3 });
      const args = [mkSmi(1), mkSmi(2)];
      const frame = new RegisterFrame(fn, args, null, null);
      expect(frame.originalArgs).toBe(args);
    });
  });
});
