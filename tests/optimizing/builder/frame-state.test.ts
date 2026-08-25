import { describe, it, expect } from "vitest";
import * as ops from "../../../src/bytecode/register/ops/bytecode.js";
import { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";
import { FrameState } from "../../../src/deopt/frame-state.js";
import {
  captureFrameState,
  captureFrameStateWithCaller,
} from "../../../src/optimizing/builder/frame-state.js";

const value = (name: string) => ({ id: name.length, type: "Constant", name });

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

function storeThenRead(): RegisterCompiledFunction {
  return compiledFunction(2, (fn) => {
    fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
    fn.emit(ops.ROP_STAR, 0);
    fn.emit(ops.ROP_LDA_REG, 0);
    fn.emit(ops.ROP_RETURN);
  });
}

const capture = (
  compiledFn: RegisterCompiledFunction | null,
  offset: number,
  regs: Map<number, unknown> | null,
  frameStates: FrameState[] = [],
) => captureFrameState(compiledFn, offset, regs, null, frameStates);

describe("captureFrameStateWithCaller", () => {
  it("numbers each frame by its place in the list it is appended to", () => {
    const frameStates: FrameState[] = [];
    const first = capture(null, 0, null, frameStates);
    const second = capture(null, 0, null, frameStates);

    expect(first.id).toBe(0);
    expect(second.id).toBe(1);
    expect(frameStates).toEqual([first, second]);
  });

  it("records the function and offset the frame resumes at", () => {
    const compiledFn = storeThenRead();

    const fs = capture(compiledFn, 2, null);

    expect(fs.compiledFunction).toBe(compiledFn);
    expect(fs.bytecodeOffset).toBe(2);
  });

  it("carries a register the resume point still reads", () => {
    const held = value("held");

    const fs = capture(storeThenRead(), 2, new Map([[0, held]]));

    expect(fs.getLocal(0)).toBe(held);
  });

  it("leaves out a register nothing reads before it is overwritten", () => {
    const dead = value("dead");

    const fs = capture(storeThenRead(), 0, new Map([[0, dead]]));

    expect(fs.hasLocal(0)).toBe(false);
  });

  it("decides per offset, so one register is dropped at one point and kept at another", () => {
    const compiledFn = storeThenRead();
    const regs = new Map([[0, value("r0")]]);

    expect(capture(compiledFn, 1, regs).hasLocal(0)).toBe(false);
    expect(capture(compiledFn, 2, regs).hasLocal(0)).toBe(true);
  });

  it("keeps a register the loop reads again only after the backedge", () => {
    const compiledFn = compiledFunction(2, (fn) => {
      fn.emit(ops.ROP_LDA_REG, 0);
      fn.emit(ops.ROP_STAR, 1);
      fn.emit(ops.ROP_JUMP, 0);
    });

    const fs = capture(compiledFn, 1, new Map([[0, value("carried")]]));

    expect(fs.hasLocal(0)).toBe(true);
  });

  it("keeps a register a closure captured, however dead the bytecode reads", () => {
    const inner = new RegisterCompiledFunction("inner", 0);
    inner.upvalues = [{ name: "captured", outerType: "local", outerSlot: 0 }];
    const compiledFn = compiledFunction(2, (fn) => {
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(ops.ROP_MAKE_CLOSURE, fn.addConstant(inner));
      fn.emit(ops.ROP_RETURN);
    });

    const fs = capture(compiledFn, 0, new Map([[0, value("captured")]]));

    expect(fs.hasLocal(0)).toBe(true);
  });

  it("keeps every register when the bytecode holds an opcode liveness cannot model", () => {
    const compiledFn = compiledFunction(2, (fn) => {
      fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
      fn.emit(ops.ROP_STAR, 0);
      fn.emit(0xfe, 0);
      fn.emit(ops.ROP_RETURN);
    });

    const fs = capture(compiledFn, 0, new Map([[0, value("unknown")]]));

    expect(fs.hasLocal(0)).toBe(true);
  });

  it("keeps every register when there is no compiled function to analyze", () => {
    const fs = capture(null, 0, new Map([[3, value("orphan")]]));

    expect(fs.getLocal(3)).toBeDefined();
  });

  it("ignores a register map that was never built", () => {
    expect(capture(storeThenRead(), 2, null).localValues.size).toBe(0);
    expect(captureFrameState(storeThenRead(), 2, undefined, null, []).localValues.size).toBe(0);
  });

  it("pushes the operand stack in the order it was given", () => {
    const first = value("first");
    const second = value("second");

    const fs = captureFrameState(null, 0, null, [first, second], []);

    expect(fs.stackValues).toEqual([first, second]);
  });

  it("leaves a frame with no caller uninlined", () => {
    const fs = captureFrameState(null, 0, null, null, []);

    expect(fs.callerFrameState).toBeNull();
    expect(fs.isInlinedFrame).toBe(false);
  });

  it("marks a frame given a caller as an inlined one", () => {
    const frameStates: FrameState[] = [];
    const caller = captureFrameState(null, 0, null, null, frameStates);

    const inlined = captureFrameStateWithCaller(null, 4, null, null, frameStates, caller);

    expect(inlined.callerFrameState).toBe(caller);
    expect(inlined.isInlinedFrame).toBe(true);
  });
});
