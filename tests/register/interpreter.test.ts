import { describe, it, expect, beforeEach } from "vitest";
import { RegisterInterpreter } from "../../src/bytecode/register/interpreter/index.js";
import { RegisterFrame, TDZ_UNINITIALIZED, isTDZUninitialized, throwIfTDZ } from "../../src/bytecode/register/interpreter/frame.js";
import {
  RegisterException,
  requiresInterpreterOnly,
  getBinaryOperands,
  errorToTaggedValue,
} from "../../src/bytecode/register/interpreter/helpers.js";
import { RegisterCompiledFunction } from "../../src/bytecode/register/ops/bytecode.js";
import * as bytecode from "../../src/bytecode/register/ops/bytecode.js";
import {
  mkSmi,
  mkDouble,
  mkString,
  mkBool,
  mkUndefined,
  mkNull,
  mkNumber,
  mkFunction,
  mkArray,
  mkObject,
  getPayload,
  getTag,
  isSmi,
  isDouble,
  isString,
  isBool,
  isUndefined,
  isNull,
  isObject,
  isArray,
  isFunction,
  toNumber,
  toDisplayString,
  isNumber,
  JSFunction,
} from "../../src/core/value/index.js";
import { createJSObject, createJSArray } from "../../src/objects/heap/factory.js";

function makeFn(name, paramCount, cb) {
  const fn = new RegisterCompiledFunction(name, paramCount);
  cb(fn);
  return fn;
}

function makeSimpleFn(name, paramCount, instructions) {
  const fn = new RegisterCompiledFunction(name, paramCount);
  fn.registerCount = Math.max(fn.registerCount, paramCount);
  for (const [op, ...operands] of instructions) {
    fn.emit(op, ...operands);
  }
  return fn;
}

describe("RegisterFrame", () => {
  it("sets params from args", () => {
    const fn = new RegisterCompiledFunction("test", 2);
    fn.registerCount = 2;
    const frame = new RegisterFrame(fn, [mkSmi(10), mkSmi(20)], mkUndefined(), null);
    expect(getPayload(frame.getReg(0))).toBe(10);
    expect(getPayload(frame.getReg(1))).toBe(20);
  });

  it("limits param count to fn.paramCount", () => {
    const fn = new RegisterCompiledFunction("test", 1);
    fn.registerCount = 2;
    const frame = new RegisterFrame(fn, [mkSmi(10), mkSmi(20)], mkUndefined(), null);
    expect(getPayload(frame.getReg(0))).toBe(10);
    expect(isUndefined(frame.getReg(1))).toBe(true);
  });

  it("setReg and getReg", () => {
    const fn = new RegisterCompiledFunction("test", 0);
    fn.registerCount = 1;
    const frame = new RegisterFrame(fn, [], mkUndefined(), null);
    frame.setReg(0, mkSmi(42));
    expect(getPayload(frame.getReg(0))).toBe(42);
  });

  it("thisValue defaults to provided or undefined", () => {
    const fn = new RegisterCompiledFunction("test", 0);
    fn.registerCount = 0;
    const frame = new RegisterFrame(fn, [], mkSmi(99), null);
    expect(getPayload(frame.thisValue)).toBe(99);

    const frame2 = new RegisterFrame(fn, [], null, null);
    expect(isUndefined(frame2.thisValue)).toBe(true);
  });

  it("TDZ uninitialized slots throw on read", () => {
    const fn = new RegisterCompiledFunction("test", 0);
    fn.registerCount = 2;
    fn.uninitializedLocalSlots = new Set([1]);
    fn.localNames = ["a", "b"];
    const frame = new RegisterFrame(fn, [], mkUndefined(), null);
    expect(isUndefined(frame.getReg(0))).toBe(true);
    expect(() => frame.getReg(1)).toThrow(/Cannot access/);
  });

  it("TDZ slot becomes readable after setReg", () => {
    const fn = new RegisterCompiledFunction("test", 0);
    fn.registerCount = 1;
    fn.uninitializedLocalSlots = new Set([0]);
    fn.localNames = ["x"];
    const frame = new RegisterFrame(fn, [], mkUndefined(), null);
    expect(() => frame.getReg(0)).toThrow();
    frame.setReg(0, mkSmi(5));
    expect(getPayload(frame.getReg(0))).toBe(5);
  });
});

describe("TDZ helpers", () => {
  it("isTDZUninitialized", () => {
    expect(isTDZUninitialized(TDZ_UNINITIALIZED)).toBe(true);
    expect(isTDZUninitialized(mkUndefined())).toBe(false);
    expect(isTDZUninitialized(null)).toBe(false);
  });

  it("throwIfTDZ passes through normal values", () => {
    const val = mkSmi(42);
    expect(throwIfTDZ(val, "x")).toBe(val);
  });

  it("throwIfTDZ throws on TDZ sentinel", () => {
    expect(() => throwIfTDZ(TDZ_UNINITIALIZED, "myVar")).toThrow(
      /Cannot access 'myVar' before initialization/,
    );
  });
});

describe("helpers", () => {
  describe("requiresInterpreterOnly", () => {
    it("returns true for async function", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      fn.isAsync = true;
      expect(requiresInterpreterOnly(fn)).toBe(true);
    });

    it("returns true for function with yield", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      fn.emit(bytecode.ROP_YIELD);
      expect(requiresInterpreterOnly(fn)).toBe(true);
    });

    it("returns true for function with await", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      fn.emit(bytecode.ROP_AWAIT);
      expect(requiresInterpreterOnly(fn)).toBe(true);
    });

    it("returns true for iterator ops", () => {
      for (const op of [
        bytecode.ROP_GET_ITERATOR,
        bytecode.ROP_ITER_NEXT,
        bytecode.ROP_ITER_DONE,
        bytecode.ROP_ITER_VALUE,
      ]) {
        const fn = new RegisterCompiledFunction("test", 0);
        fn.emit(op);
        expect(requiresInterpreterOnly(fn)).toBe(true);
      }
    });

    it("returns false for plain function", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      fn.emit(bytecode.ROP_LDA_CONST, 0);
      fn.emit(bytecode.ROP_RETURN);
      expect(requiresInterpreterOnly(fn)).toBe(false);
    });
  });

  describe("getBinaryOperands", () => {
    it("reads acc as left and register as right", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      fn.registerCount = 1;
      const frame = new RegisterFrame(fn, [], mkUndefined(), null);
      frame.acc = mkSmi(10);
      frame.setReg(0, mkSmi(20));
      const { left, right } = getBinaryOperands(frame, [0, -1], fn);
      expect(getPayload(left)).toBe(10);
      expect(getPayload(right)).toBe(20);
    });
  });

  describe("errorToTaggedValue", () => {
    it("unwraps RegisterException", () => {
      const val = mkString("err");
      const result = errorToTaggedValue(new RegisterException(val));
      expect(result).toBe(val);
    });

    it("converts plain Error to string", () => {
      const result = errorToTaggedValue(new Error("boom"));
      expect(isString(result)).toBe(true);
      expect(getPayload(result)).toBe("boom");
    });
  });
});

describe("RegisterInterpreter", () => {
  let interp;

  beforeEach(() => {
    interp = new RegisterInterpreter(null);
  });

  describe("wrapConstant", () => {
    it("wraps number", () => {
      const r = interp.wrapConstant(42);
      expect(isNumber(r)).toBe(true);
      expect(toNumber(r)).toBe(42);
    });

    it("wraps float", () => {
      const r = interp.wrapConstant(3.14);
      expect(toNumber(r)).toBeCloseTo(3.14);
    });

    it("wraps string", () => {
      const r = interp.wrapConstant("hello");
      expect(isString(r)).toBe(true);
      expect(getPayload(r)).toBe("hello");
    });

    it("wraps boolean true", () => {
      const r = interp.wrapConstant(true);
      expect(isBool(r)).toBe(true);
      expect(getPayload(r)).toBe(true);
    });

    it("wraps boolean false", () => {
      expect(getPayload(interp.wrapConstant(false))).toBe(false);
    });

    it("wraps null", () => {
      expect(isNull(interp.wrapConstant(null))).toBe(true);
    });

    it("wraps undefined", () => {
      expect(isUndefined(interp.wrapConstant(undefined))).toBe(true);
    });

    it("wraps RegisterCompiledFunction as function", () => {
      const fn = new RegisterCompiledFunction("test", 0);
      const r = interp.wrapConstant(fn);
      expect(isFunction(r)).toBe(true);
    });
  });

  describe("runFrame - load/store ops", () => {
    it("LDA_CONST loads constant into acc", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [42];
      const result = interp.execute(fn);
      expect(toNumber(result)).toBe(42);
    });

    it("STAR stores acc into register", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_STAR, 0],
        [bytecode.ROP_LDA_CONST, 1],
        [bytecode.ROP_STAR, 1],
        [bytecode.ROP_LDA_REG, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 2;
      fn.constants = [10, 20];
      const result = interp.execute(fn);
      expect(toNumber(result)).toBe(10);
    });

    it("LDA_REG loads register into acc", () => {
      const fn = makeSimpleFn("test", 1, [
        [bytecode.ROP_LDA_REG, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 1;
      const result = interp.execute(fn, [mkSmi(77)]);
      expect(toNumber(result)).toBe(77);
    });

    it("MOV copies register to register", () => {
      const fn = makeSimpleFn("test", 1, [
        [bytecode.ROP_MOV, 0, 1],
        [bytecode.ROP_LDA_REG, 1],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 2;
      const result = interp.execute(fn, [mkSmi(55)]);
      expect(toNumber(result)).toBe(55);
    });
  });

  describe("runFrame - literal ops", () => {
    it("LDA_UNDEFINED", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_UNDEFINED],
        [bytecode.ROP_RETURN],
      ]);
      expect(isUndefined(interp.execute(fn))).toBe(true);
    });

    it("LDA_NULL", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_NULL],
        [bytecode.ROP_RETURN],
      ]);
      expect(isNull(interp.execute(fn))).toBe(true);
    });

    it("LDA_TRUE", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_TRUE],
        [bytecode.ROP_RETURN],
      ]);
      expect(getPayload(interp.execute(fn))).toBe(true);
    });

    it("LDA_FALSE", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_FALSE],
        [bytecode.ROP_RETURN],
      ]);
      expect(getPayload(interp.execute(fn))).toBe(false);
    });

    it("LDA_THIS", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_THIS],
        [bytecode.ROP_RETURN],
      ]);
      const thisVal = mkSmi(123);
      const result = interp.execute(fn, [], thisVal);
      expect(toNumber(result)).toBe(123);
    });
  });

  describe("runFrame - arithmetic", () => {
    function makeArithFn(op) {
      const fn = makeSimpleFn("test", 2, [
        [bytecode.ROP_LDA_REG, 0],
        [op, 1, -1],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 2;
      return fn;
    }

    it("ADD integers", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_ADD), [mkSmi(3), mkSmi(4)]);
      expect(toNumber(result)).toBe(7);
    });

    it("ADD strings", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_ADD), [mkString("a"), mkString("b")]);
      expect(getPayload(result)).toBe("ab");
    });

    it("ADD string + number coercion", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_ADD), [mkString("x"), mkSmi(1)]);
      expect(getPayload(result)).toBe("x1");
    });

    it("ADD doubles", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_ADD), [mkDouble(1.5), mkDouble(2.5)]);
      expect(toNumber(result)).toBeCloseTo(4.0);
    });

    it("SUB", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_SUB), [mkSmi(10), mkSmi(3)]);
      expect(toNumber(result)).toBe(7);
    });

    it("MUL", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_MUL), [mkSmi(4), mkSmi(5)]);
      expect(toNumber(result)).toBe(20);
    });

    it("DIV integer result", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_DIV), [mkSmi(10), mkSmi(2)]);
      expect(toNumber(result)).toBe(5);
    });

    it("DIV float result", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_DIV), [mkSmi(7), mkSmi(2)]);
      expect(toNumber(result)).toBeCloseTo(3.5);
    });

    it("MOD", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_MOD), [mkSmi(7), mkSmi(3)]);
      expect(toNumber(result)).toBe(1);
    });

    it("POW", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_POW), [mkSmi(2), mkSmi(10)]);
      expect(toNumber(result)).toBe(1024);
    });

    it("SUB overflow to double", () => {
      const result = interp.execute(makeArithFn(bytecode.ROP_MUL), [mkSmi(100000), mkSmi(100000)]);
      expect(toNumber(result)).toBe(10000000000);
    });
  });

  describe("runFrame - bitwise", () => {
    function makeBitwiseFn(op) {
      const fn = makeSimpleFn("test", 2, [
        [bytecode.ROP_LDA_REG, 0],
        [op, 1, -1],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 2;
      return fn;
    }

    it("BITAND", () => {
      expect(toNumber(interp.execute(makeBitwiseFn(bytecode.ROP_BITAND), [mkSmi(0xFF), mkSmi(0x0F)]))).toBe(0x0F);
    });

    it("BITOR", () => {
      expect(toNumber(interp.execute(makeBitwiseFn(bytecode.ROP_BITOR), [mkSmi(0xF0), mkSmi(0x0F)]))).toBe(0xFF);
    });

    it("BITXOR", () => {
      expect(toNumber(interp.execute(makeBitwiseFn(bytecode.ROP_BITXOR), [mkSmi(0xFF), mkSmi(0x0F)]))).toBe(0xF0);
    });

    it("SHL", () => {
      expect(toNumber(interp.execute(makeBitwiseFn(bytecode.ROP_SHL), [mkSmi(1), mkSmi(4)]))).toBe(16);
    });

    it("SHR", () => {
      expect(toNumber(interp.execute(makeBitwiseFn(bytecode.ROP_SHR), [mkSmi(16), mkSmi(2)]))).toBe(4);
    });

    it("USHR", () => {
      expect(toNumber(interp.execute(makeBitwiseFn(bytecode.ROP_USHR), [mkSmi(-1), mkSmi(0)]))).toBe(4294967295);
    });
  });

  describe("runFrame - unary ops", () => {
    it("NOT", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_TRUE],
        [bytecode.ROP_NOT],
        [bytecode.ROP_RETURN],
      ]);
      expect(getPayload(interp.execute(fn))).toBe(false);
    });

    it("NEG", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_NEG],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [5];
      expect(toNumber(interp.execute(fn))).toBe(-5);
    });

    it("TYPEOF number", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_TYPEOF],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [42];
      expect(getPayload(interp.execute(fn))).toBe("number");
    });

    it("TYPEOF string", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_TYPEOF],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = ["hello"];
      expect(getPayload(interp.execute(fn))).toBe("string");
    });

    it("BITNOT", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_BITNOT],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [0];
      expect(toNumber(interp.execute(fn))).toBe(-1);
    });

    it("VOID", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_VOID],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [42];
      expect(isUndefined(interp.execute(fn))).toBe(true);
    });
  });

  describe("runFrame - comparison ops", () => {
    function makeCmpFn(op) {
      const fn = makeSimpleFn("test", 2, [
        [bytecode.ROP_LDA_REG, 0],
        [op, 1, -1],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 2;
      return fn;
    }

    it("EQ true", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_EQ), [mkSmi(1), mkSmi(1)]))).toBe(true);
    });

    it("EQ false", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_EQ), [mkSmi(1), mkSmi(2)]))).toBe(false);
    });

    it("EQ strings", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_EQ), [mkString("a"), mkString("a")]))).toBe(true);
    });

    it("EQ different types", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_EQ), [mkSmi(1), mkString("1")]))).toBe(false);
    });

    it("NEQ", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_NEQ), [mkSmi(1), mkSmi(2)]))).toBe(true);
    });

    it("LT", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_LT), [mkSmi(1), mkSmi(2)]))).toBe(true);
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_LT), [mkSmi(2), mkSmi(1)]))).toBe(false);
    });

    it("GT", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_GT), [mkSmi(2), mkSmi(1)]))).toBe(true);
    });

    it("LTE", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_LTE), [mkSmi(1), mkSmi(1)]))).toBe(true);
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_LTE), [mkSmi(1), mkSmi(2)]))).toBe(true);
    });

    it("GTE", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_GTE), [mkSmi(2), mkSmi(2)]))).toBe(true);
    });

    it("LOOSE_EQ null == undefined", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_LOOSE_EQ), [mkNull(), mkUndefined()]))).toBe(true);
    });

    it("LOOSE_NEQ", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_LOOSE_NEQ), [mkSmi(1), mkSmi(2)]))).toBe(true);
    });

    it("EQ null == null", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_EQ), [mkNull(), mkNull()]))).toBe(true);
    });

    it("EQ undefined == undefined", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_EQ), [mkUndefined(), mkUndefined()]))).toBe(true);
    });

    it("EQ booleans", () => {
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_EQ), [mkBool(true), mkBool(true)]))).toBe(true);
      expect(getPayload(interp.execute(makeCmpFn(bytecode.ROP_EQ), [mkBool(true), mkBool(false)]))).toBe(false);
    });
  });

  describe("runFrame - jumps", () => {
    it("JUMP unconditional", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_JUMP, 2],
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_LDA_CONST, 1],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [111, 222];
      expect(toNumber(interp.execute(fn))).toBe(222);
    });

    it("JUMP_IF_FALSE skips when false", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_FALSE],
        [bytecode.ROP_JUMP_IF_FALSE, 3],
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_LDA_CONST, 1],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [111, 222];
      expect(toNumber(interp.execute(fn))).toBe(222);
    });

    it("JUMP_IF_FALSE falls through when true", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_TRUE],
        [bytecode.ROP_JUMP_IF_FALSE, 3],
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [111];
      expect(toNumber(interp.execute(fn))).toBe(111);
    });

    it("JUMP_IF_TRUE jumps when true", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_TRUE],
        [bytecode.ROP_JUMP_IF_TRUE, 3],
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_LDA_CONST, 1],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [111, 222];
      expect(toNumber(interp.execute(fn))).toBe(222);
    });
  });

  describe("runFrame - object ops", () => {
    it("NEW_OBJECT creates empty object", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_NEW_OBJECT],
        [bytecode.ROP_RETURN],
      ]);
      const result = interp.execute(fn);
      expect(isObject(result)).toBe(true);
    });

    it("NEW_ARRAY creates array", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_STAR, 0],
        [bytecode.ROP_LDA_CONST, 1],
        [bytecode.ROP_STAR, 1],
        [bytecode.ROP_NEW_ARRAY, 0, 2],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 2;
      fn.constants = [10, 20];
      const result = interp.execute(fn);
      expect(isArray(result)).toBe(true);
      const arr = getPayload(result);
      expect(arr.getLength()).toBe(2);
      expect(toNumber(arr.getIndex(0))).toBe(10);
      expect(toNumber(arr.getIndex(1))).toBe(20);
    });

    it("GET_LENGTH on array", () => {
      const fn = makeSimpleFn("test", 1, [
        [bytecode.ROP_GET_LENGTH, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 1;
      const arr = createJSArray([mkSmi(1), mkSmi(2), mkSmi(3)]);
      const result = interp.execute(fn, [mkArray(arr)]);
      expect(toNumber(result)).toBe(3);
    });

    it("GET_LENGTH on string", () => {
      const fn = makeSimpleFn("test", 1, [
        [bytecode.ROP_GET_LENGTH, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 1;
      const result = interp.execute(fn, [mkString("hello")]);
      expect(toNumber(result)).toBe(5);
    });

    it("ARRAY_PUSH", () => {
      const fn = makeSimpleFn("test", 1, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_ARRAY_PUSH, 0],
        [bytecode.ROP_LDA_REG, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 1;
      fn.constants = [99];
      const arr = createJSArray([mkSmi(1)]);
      const result = interp.execute(fn, [mkArray(arr)]);
      expect(getPayload(result).getLength()).toBe(2);
    });
  });

  describe("runFrame - IS_NULLISH", () => {
    it("null is nullish", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_NULL],
        [bytecode.ROP_IS_NULLISH],
        [bytecode.ROP_RETURN],
      ]);
      expect(getPayload(interp.execute(fn))).toBe(true);
    });

    it("undefined is nullish", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_UNDEFINED],
        [bytecode.ROP_IS_NULLISH],
        [bytecode.ROP_RETURN],
      ]);
      expect(getPayload(interp.execute(fn))).toBe(true);
    });

    it("number is not nullish", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_IS_NULLISH],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [42];
      expect(getPayload(interp.execute(fn))).toBe(false);
    });
  });

  describe("runFrame - exception handling", () => {
    it("THROW without handler propagates", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_THROW],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [42];
      expect(() => interp.execute(fn)).toThrow(RegisterException);
    });

    it("TRY_START/TRY_END catches exception", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_TRY_START, 4],
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_THROW],
        [bytecode.ROP_TRY_END],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [42];
      const result = interp.execute(fn);
      expect(toNumber(result)).toBe(42);
    });
  });

  describe("runFrame - REST_ARGS", () => {
    it("collects rest args", () => {
      const fn = makeSimpleFn("test", 1, [
        [bytecode.ROP_REST_ARGS, 1],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 1;
      const result = interp.execute(fn, [mkSmi(1), mkSmi(2), mkSmi(3)]);
      expect(isArray(result)).toBe(true);
      expect(getPayload(result).getLength()).toBe(2);
    });
  });

  describe("runFrame - globals", () => {
    it("LDA_GLOBAL reads global cell", () => {
      interp.globalCells.write("myGlobal", mkSmi(999));
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_GLOBAL, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = ["myGlobal"];
      expect(toNumber(interp.execute(fn))).toBe(999);
    });

    it("STA_GLOBAL writes global cell", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 1],
        [bytecode.ROP_STA_GLOBAL, 0],
        [bytecode.ROP_LDA_GLOBAL, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = ["testVar", 777];
      expect(toNumber(interp.execute(fn))).toBe(777);
    });

    it("LDA_GLOBAL throws on undefined variable", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_GLOBAL, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = ["nonexistent_var_xyz"];
      expect(() => interp.execute(fn)).toThrow(/not defined/);
    });
  });

  describe("runFrame - CALL", () => {
    it("calls native function via global", () => {
      interp.globalCells.write("double", mkFunction({
        name: "double",
        call: (args) => mkSmi(toNumber(args[0]) * 2),
      }));
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_GLOBAL, 0],
        [bytecode.ROP_STAR, 0],
        [bytecode.ROP_LDA_CONST, 1],
        [bytecode.ROP_STAR, 1],
        [bytecode.ROP_CALL, 0, 1, 1, -1],
        [bytecode.ROP_RETURN],
      ]);
      fn.registerCount = 2;
      fn.constants = ["double", 21];
      const result = interp.execute(fn);
      expect(toNumber(result)).toBe(42);
    });
  });

  describe("runFrame - NEW_REGEX", () => {
    it("creates regex", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_NEW_REGEX, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [{ pattern: "abc", flags: "gi" }];
      const result = interp.execute(fn);
      const regex = getPayload(result);
      expect(regex.nativeRegex).toBeInstanceOf(RegExp);
      expect(regex.nativeRegex.source).toBe("abc");
      expect(regex.nativeRegex.flags).toBe("gi");
    });
  });

  describe("runFrame - returns undefined at end", () => {
    it("implicit return", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
      ]);
      fn.constants = [42];
      expect(isUndefined(interp.execute(fn))).toBe(true);
    });
  });

  describe("initFeedbackVector", () => {
    it("does not recreate on second call", () => {
      const fn = makeSimpleFn("test", 0, [
        [bytecode.ROP_LDA_CONST, 0],
        [bytecode.ROP_RETURN],
      ]);
      fn.constants = [1];
      fn.feedbackSlotCount = 1;
      interp.initFeedbackVector(fn);
      const fv = fn.feedbackVector;
      interp.initFeedbackVector(fn);
      expect(fn.feedbackVector).toBe(fv);
    });
  });

  describe("globalCells", () => {
    it("read/write roundtrip", () => {
      interp.globalCells.write("testKey", mkSmi(42));
      expect(toNumber(interp.globalCells.read("testKey"))).toBe(42);
    });
  });
});
