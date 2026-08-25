import { describe, it, expect } from "vitest";
import * as ops from "../../../../src/bytecode/register/ops/bytecode.js";
import {
  RegisterCompiledFunction,
  RegisterInstruction,
} from "../../../../src/bytecode/register/ops/bytecode.js";
import {
  closureCaptures,
  closureCapturedSlots,
  controlEffectOf,
  forEachRegisterRead,
  forEachRegisterWrite,
  handlerTargetOf,
  jumpTargetOf,
  registerEffectsOf,
} from "../../../../src/bytecode/register/ops/register-effects.js";

const declaredOpcodes = (): Array<[string, number]> =>
  Object.entries(ops).filter(
    (entry): entry is [string, number] =>
      entry[0].startsWith("ROP_") && typeof entry[1] === "number",
  );

const readsOf = (opcode: number, ...operands: number[]): number[] => {
  const slots: number[] = [];
  forEachRegisterRead(new RegisterInstruction(opcode, ...operands), (slot) =>
    slots.push(slot),
  );
  return slots;
};

const writesOf = (opcode: number, ...operands: number[]): number[] => {
  const slots: number[] = [];
  forEachRegisterWrite(new RegisterInstruction(opcode, ...operands), (slot) =>
    slots.push(slot),
  );
  return slots;
};

const TARGET = 12;

const controlOpcodes = () =>
  declaredOpcodes().filter(
    ([, opcode]) => (registerEffectsOf(opcode)?.control ?? "next") !== "next",
  );

describe("register effects", () => {
  it("models every opcode the instruction set declares", () => {
    const missing = declaredOpcodes()
      .filter(([, opcode]) => registerEffectsOf(opcode) === null)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("reports no effects for an opcode outside the instruction set", () => {
    const declared = new Set(declaredOpcodes().map(([, opcode]) => opcode));
    const undeclared = [...Array(256).keys()].find((code) => !declared.has(code));
    expect(registerEffectsOf(undeclared!)).toBeNull();
  });

  it("separates the source and destination of a move", () => {
    expect(readsOf(ops.ROP_MOV, 3, 7)).toEqual([3]);
    expect(writesOf(ops.ROP_MOV, 3, 7)).toEqual([7]);
  });

  it("treats a store into a register as a write only", () => {
    expect(readsOf(ops.ROP_STAR, 2)).toEqual([]);
    expect(writesOf(ops.ROP_STAR, 2)).toEqual([2]);
  });

  it("skips the feedback slot that trails a binary operand", () => {
    expect(readsOf(ops.ROP_ADD, 4, 9)).toEqual([4]);
  });

  it("expands the argument window of a call", () => {
    expect(readsOf(ops.ROP_CALL, 1, 5, 3, 0)).toEqual([1, 5, 6, 7]);
  });

  it("expands both windows of a call with named arguments", () => {
    expect(readsOf(ops.ROP_CALL_NAMED, 1, 4, 2, 8, 0, 2, 0)).toEqual([
      1, 4, 5, 8, 9,
    ]);
  });

  it("reads every trailing index register of a keyed slice", () => {
    expect(readsOf(ops.ROP_LDA_KEYED_SLICE, 2, 0, 5, 6, 7)).toEqual([2, 5, 6, 7]);
  });

  it("ignores the constant-keyed form of a property delete", () => {
    expect(readsOf(ops.ROP_DELETE_PROP, 2, 4)).toEqual([2]);
    expect(readsOf(ops.ROP_DELETE_PROP, 2, 0, 6)).toEqual([2, 6]);
  });

  it("ignores an accessor half that was never supplied", () => {
    expect(readsOf(ops.ROP_DEFINE_ACCESSOR, 1, 0, 4, -1)).toEqual([1, 4]);
  });

  it("collects the outer locals a closure captures", () => {
    const inner = new RegisterCompiledFunction("inner", 0);
    inner.upvalues = [
      { name: "captured", outerType: "local", outerSlot: 2 },
      { name: "outerUpvalue", outerType: "upvalue", outerSlot: 5 },
    ];
    const outer = new RegisterCompiledFunction("outer", 0);
    outer.emit(ops.ROP_MAKE_CLOSURE, outer.addConstant(inner));

    expect([...closureCapturedSlots(outer)]).toEqual([2]);
  });

  it("collects nothing when no instruction builds a closure", () => {
    const fn = new RegisterCompiledFunction("plain", 0);
    fn.emit(ops.ROP_LDA_CONST, fn.addConstant(1));
    fn.emit(ops.ROP_RETURN);

    expect(closureCapturedSlots(fn).size).toBe(0);
  });

  it("reads a capture out of the enclosing frame's own register", () => {
    expect(
      closureCaptures({ upvalues: [{ name: "x", outerType: "local", outerSlot: 4 }] }),
    ).toEqual([{ source: "local", slot: 4 }]);
  });

  it("reads a capture that the enclosing function had itself captured", () => {
    expect(
      closureCaptures({ upvalues: [{ name: "x", outerType: "upvalue", outerSlot: 1 }] }),
    ).toEqual([{ source: "upvalue", slot: 1 }]);
  });

  it("treats a descriptor that denies being local as one more upvalue", () => {
    expect(closureCaptures({ upvalues: [{ name: "x", isLocal: false, outerSlot: 2 }] })).toEqual([
      { source: "upvalue", slot: 2 },
    ]);
  });

  it("falls back to the descriptor index when no outer slot was written", () => {
    expect(closureCaptures({ upvalues: [{ name: "x", index: 6, isLocal: true }] })).toEqual([
      { source: "local", slot: 6 },
    ]);
  });

  it("skips a descriptor that names no slot at all", () => {
    expect(closureCaptures({ upvalues: [{ name: "x" }] })).toEqual([]);
  });
});

describe("register control effects", () => {
  it("sends an unconditional jump to its target and nowhere else", () => {
    const jump = new RegisterInstruction(ops.ROP_JUMP, TARGET);

    expect(controlEffectOf(ops.ROP_JUMP)).toBe("jump");
    expect(jumpTargetOf(jump)).toBe(TARGET);
  });

  it("names the target of either conditional jump", () => {
    expect(controlEffectOf(ops.ROP_JUMP_IF_TRUE)).toBe("branch");
    expect(controlEffectOf(ops.ROP_JUMP_IF_FALSE)).toBe("branch");
    expect(jumpTargetOf(new RegisterInstruction(ops.ROP_JUMP_IF_TRUE, TARGET))).toBe(TARGET);
    expect(jumpTargetOf(new RegisterInstruction(ops.ROP_JUMP_IF_FALSE, TARGET))).toBe(TARGET);
  });

  it("ends the path at a return and at a throw alike", () => {
    expect(controlEffectOf(ops.ROP_RETURN)).toBe("terminate");
    expect(controlEffectOf(ops.ROP_THROW)).toBe("terminate");
  });

  it("opens a handler at a try and closes it at its end", () => {
    expect(controlEffectOf(ops.ROP_TRY_START)).toBe("enter-handler");
    expect(controlEffectOf(ops.ROP_TRY_END)).toBe("leave-handler");
    expect(handlerTargetOf(new RegisterInstruction(ops.ROP_TRY_START, TARGET))).toBe(TARGET);
  });

  it("keeps the handler of a try apart from the target of a jump", () => {
    expect(jumpTargetOf(new RegisterInstruction(ops.ROP_TRY_START, TARGET))).toBeNull();
    expect(handlerTargetOf(new RegisterInstruction(ops.ROP_JUMP, TARGET))).toBeNull();
  });

  it("lets an ordinary instruction fall through to the next one", () => {
    const add = new RegisterInstruction(ops.ROP_ADD, 1, 0);

    expect(controlEffectOf(ops.ROP_ADD)).toBe("next");
    expect(jumpTargetOf(add)).toBeNull();
    expect(handlerTargetOf(add)).toBeNull();
  });

  it("answers no control effect for an opcode outside the instruction set", () => {
    const declared = new Set(declaredOpcodes().map(([, opcode]) => opcode));
    const undeclared = [...Array(256).keys()].find((code) => !declared.has(code))!;

    expect(controlEffectOf(undeclared)).toBeNull();
    expect(jumpTargetOf(new RegisterInstruction(undeclared, TARGET))).toBeNull();
  });

  it("never reads or writes the operand that carries a control target", () => {
    const carrying = controlOpcodes().filter(
      ([, opcode]) => controlEffectOf(opcode) !== "leave-handler",
    );
    const touched = carrying.filter(
      ([, opcode]) =>
        readsOf(opcode, TARGET).includes(TARGET) || writesOf(opcode, TARGET).includes(TARGET),
    );

    expect(carrying.length).toBeGreaterThan(0);
    expect(touched.map(([name]) => name)).toEqual([]);
  });

  it("gives no opcode both a read and a write of the same operand", () => {
    const overlapping = declaredOpcodes().filter(([, opcode]) => {
      const effect = registerEffectsOf(opcode)!;
      return effect.reads.some((index) => effect.writes.includes(index));
    });

    expect(overlapping.map(([name]) => name)).toEqual([]);
  });
});
