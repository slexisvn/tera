import { describe, it, expect } from "vitest";
import {
  RegisterCompiledFunction,
  ROP_LDA_CONST,
  ROP_STAR,
  ROP_RETURN,
  ROP_JUMP,
  ROP_LDA_UNDEFINED,
} from "../../../src/bytecode/register/ops/bytecode.js";

describe("RegisterCompiledFunction", () => {
  describe("constant pool", () => {
    it("deduplicates primitive constants, returns same index", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      const i1 = fn.addConstant(42);
      const i2 = fn.addConstant(42);
      const i3 = fn.addConstant("hello");
      const i4 = fn.addConstant("hello");
      expect(i1).toBe(i2);
      expect(i3).toBe(i4);
      expect(fn.constants).toHaveLength(2);
    });

    it("does NOT deduplicate object constants (each gets new slot)", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      const obj = { a: 1 };
      const i1 = fn.addConstant(obj);
      const i2 = fn.addConstant(obj);
      expect(i1).not.toBe(i2);
      expect(fn.constants).toHaveLength(2);
    });

    it("deduplicates null correctly", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      const i1 = fn.addConstant(null);
      const i2 = fn.addConstant(null);
      expect(i1).toBe(i2);
    });
  });

  describe("locals and registers", () => {
    it("addLocal tracks names and grows registerCount", () => {
      const fn = new RegisterCompiledFunction("test", 2);
      const s0 = fn.addLocal("x");
      const s1 = fn.addLocal("y");
      expect(s0).toBe(0);
      expect(s1).toBe(1);
      expect(fn.localNames).toEqual(["x", "y"]);
      expect(fn.registerCount).toBeGreaterThanOrEqual(2);
    });

    it("setLocalBindingKind marks const/let as uninitialized (TDZ)", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      const slot = fn.addLocal("a");
      fn.setLocalBindingKind(slot, "const");
      expect(fn.uninitializedLocalSlots.has(slot)).toBe(true);
      expect(fn.localBindingKinds[slot]).toBe("const");
    });

    it("allocTemp returns incrementing register indices", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      fn.registerCount = 3;
      const t1 = fn.allocTemp();
      const t2 = fn.allocTemp();
      expect(t2).toBe(t1 + 1);
      expect(fn.registerCount).toBe(5);
    });
  });

  describe("emit and patchJump", () => {
    it("emit appends instruction and returns its index", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      const idx = fn.emit(ROP_LDA_CONST, 0);
      expect(idx).toBe(0);
      expect(fn.instructions).toHaveLength(1);
      expect(fn.instructions[0].opcode).toBe(ROP_LDA_CONST);
    });

    it("patchJump updates operand[0] of target instruction", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      const jumpIdx = fn.emit(ROP_JUMP, 0);
      fn.emit(ROP_LDA_UNDEFINED);
      fn.emit(ROP_RETURN);
      fn.patchJump(jumpIdx, 2);
      expect(fn.instructions[jumpIdx].operands[0]).toBe(2);
    });
  });

  describe("feedbackSlots", () => {
    it("allocFeedbackSlot returns incrementing indices", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      expect(fn.allocFeedbackSlot()).toBe(0);
      expect(fn.allocFeedbackSlot()).toBe(1);
      expect(fn.feedbackSlotCount).toBe(2);
    });
  });

  describe("disassemble", () => {
    it("produces readable output with constants, locals, and instructions", () => {
      const fn = new RegisterCompiledFunction("add", 2);
      fn.addLocal("a");
      fn.addLocal("b");
      fn.addConstant(42);
      fn.emit(ROP_LDA_CONST, 0);
      fn.emit(ROP_STAR, 0);
      fn.emit(ROP_RETURN);

      const output = fn.disassemble();
      expect(output).toContain("add");
      expect(output).toContain("42");
      expect(output).toContain("LdaConst");
      expect(output).toContain("Star");
      expect(output).toContain("Return");
      expect(output).toContain("r0=a");
    });
  });

  describe("getICKey", () => {
    it("generates and caches IC keys per feedback slot", () => {
      const fn = new RegisterCompiledFunction("myFunc", 0);
      fn.feedbackSlotCount = 3;
      const k0 = fn.getICKey("myFunc", 0);
      const k1 = fn.getICKey("myFunc", 1);
      expect(k0).not.toBe(k1);
      expect(k0).toContain("myFunc");
      expect(fn.getICKey("myFunc", 0)).toBe(k0);
    });
  });
});
