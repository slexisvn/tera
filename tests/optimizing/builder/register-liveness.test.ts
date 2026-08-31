import { describe, it, expect } from "vitest";
import * as ops from "../../../src/bytecode/register/ops/bytecode.js";
import { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";
import { registerLiveness } from "../../../src/optimizing/builder/register-liveness.js";

function compiledFunction(
  registerCount: number,
  emit: (fn: RegisterCompiledFunction) => void,
): RegisterCompiledFunction {
  const fn = new RegisterCompiledFunction("test", 0);
  fn.registerCount = registerCount;
  fn.localCount = registerCount;
  emit(fn);
  return fn;
}

function livenessOf(
  registerCount: number,
  emit: (fn: RegisterCompiledFunction) => void,
) {
  const liveness = registerLiveness(compiledFunction(registerCount, emit));
  expect(liveness).not.toBeNull();
  return liveness!;
}

describe("registerLiveness", () => {
  it("drops a register the next instruction overwrites before reading", () => {
    const liveness = livenessOf(1, (fn) => {
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_LDA_REG, 0);
      fn.emit(ops.ROP_RETURN);
    });

    expect(liveness.isLive(0, 0)).toBe(false);
    expect(liveness.isLive(1, 0)).toBe(false);
    expect(liveness.isLive(2, 0)).toBe(true);
  });

  it("keeps a register the loop reads again after the backedge", () => {
    const liveness = livenessOf(2, (fn) => {
      fn.emit(ops.ROP_LDA_REG, 0);
      fn.emit(ops.ROP_STAR, 1);
      fn.emit(ops.ROP_JUMP, 0);
    });

    expect(liveness.isLive(0, 0)).toBe(true);
    expect(liveness.isLive(1, 0)).toBe(true);
    expect(liveness.isLive(2, 0)).toBe(true);
  });

  it("drops a register the loop body rewrites before the next read", () => {
    const liveness = livenessOf(2, (fn) => {
      fn.emit(ops.ROP_LDA_REG, 0);
      fn.emit(ops.ROP_STAR, 1);
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_JUMP, 0);
    });

    expect(liveness.isLive(0, 0)).toBe(true);
    expect(liveness.isLive(2, 0)).toBe(false);
    expect(liveness.isLive(3, 0)).toBe(false);
  });

  it("keeps a register only the catch body reads", () => {
    const liveness = livenessOf(2, (fn) => {
      fn.emit(ops.ROP_TRY_START, 5);
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_TRY_END);
      fn.emit(ops.ROP_JUMP, 7);
      fn.emit(ops.ROP_LDA_REG, 0);
      fn.emit(ops.ROP_STAR, 1);
      fn.emit(ops.ROP_RETURN);
    });

    expect(liveness.isLive(1, 0)).toBe(true);
    expect(liveness.isLive(4, 0)).toBe(false);
  });

  it("drops a register only the code after an uncaught throw would read", () => {
    const liveness = livenessOf(1, (fn) => {
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_THROW);
      fn.emit(ops.ROP_LDA_REG, 0);
      fn.emit(ops.ROP_RETURN);
    });

    expect(liveness.isLive(2, 0)).toBe(false);
  });

  it("keeps a register the handler reads when the throw is inside a try", () => {
    const liveness = livenessOf(1, (fn) => {
      fn.emit(ops.ROP_TRY_START, 4);
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_THROW);
      fn.emit(ops.ROP_TRY_END);
      fn.emit(ops.ROP_LDA_REG, 0);
      fn.emit(ops.ROP_RETURN);
    });

    expect(liveness.isLive(2, 0)).toBe(true);
  });

  it("keeps every register a closure captured, across its own rewrites", () => {
    const inner = new RegisterCompiledFunction("inner", 0);
    inner.upvalues = [{ name: "captured", outerType: "local", outerSlot: 0 }];
    const liveness = livenessOf(2, (fn) => {
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_MAKE_CLOSURE, fn.addConstant(inner));
      fn.emit(ops.ROP_STAR, 1);
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(2));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_RETURN);
    });

    expect(liveness.isLive(0, 0)).toBe(true);
    expect(liveness.isLive(4, 0)).toBe(true);
    expect(liveness.isLive(0, 1)).toBe(false);
  });

  it("keeps every register inside the argument window of a call", () => {
    const liveness = livenessOf(5, (fn) => {
      fn.emit(ops.ROP_CALL, 0, 2, 3, 0);
      fn.emit(ops.ROP_RETURN);
    });

    expect(liveness.isLive(0, 0)).toBe(true);
    expect(liveness.isLive(0, 1)).toBe(false);
    expect(liveness.isLive(0, 2)).toBe(true);
    expect(liveness.isLive(0, 3)).toBe(true);
    expect(liveness.isLive(0, 4)).toBe(true);
  });

  it("declines to analyze bytecode holding an opcode it cannot model", () => {
    const fn = compiledFunction(1, (target) => {
      target.emit(ops.ROP_LDA_CONST, target.addConstant(1));
      target.emit(0xfe, 0);
      target.emit(ops.ROP_RETURN);
    });

    expect(registerLiveness(fn)).toBeNull();
  });

  it("settles on a loop whose live register sits in the top bit of a word", () => {
    const liveness = livenessOf(32, (fn) => {
      fn.emit(ops.ROP_LDA_REG, 31);
      fn.emit(ops.ROP_STAR, 30);
      fn.emit(ops.ROP_JUMP, 0);
    });

    expect(liveness.isLive(0, 31)).toBe(true);
    expect(liveness.isLive(2, 31)).toBe(true);
    expect(liveness.isLive(0, 30)).toBe(false);
  });

  it("reports a register live at an offset outside the bytecode", () => {
    const liveness = livenessOf(1, (fn) => {
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_RETURN);
    });

    expect(liveness.isLive(3, 0)).toBe(true);
  });
});
