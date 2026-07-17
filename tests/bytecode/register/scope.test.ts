import { describe, it, expect } from "vitest";
import { Scope, analyzeSimpleConstructor } from "../../../src/bytecode/register/compiler/helpers.js";
import {
  RegisterCompiledFunction,
  ROP_LDA_THIS,
  ROP_STAR,
  ROP_LDA_REG,
  ROP_STA_PROP,
  ROP_LDA_UNDEFINED,
  ROP_RETURN,
  ROP_LDA_CONST,
  ROP_ADD,
} from "../../../src/bytecode/register/ops/bytecode.js";

describe("Scope", () => {
  describe("define and resolve", () => {
    it("resolves locally defined variables", () => {
      const scope = new Scope();
      scope.define("x", 0);
      const result = scope.resolve("x");
      expect(result.type).toBe("local");
      expect(result.slot).toBe(0);
      expect(result.kind).toBe("let");
    });

    it("resolves through parent scope chain", () => {
      const parent = new Scope();
      parent.define("outer", 5);
      const child = new Scope(parent);
      const result = child.resolve("outer");
      expect(result.type).toBe("local");
      expect(result.slot).toBe(5);
    });

    it("returns null for undeclared variables", () => {
      const scope = new Scope();
      expect(scope.resolve("nope")).toBeNull();
    });

    it("child shadows parent with same name", () => {
      const parent = new Scope();
      parent.define("x", 0);
      const child = new Scope(parent);
      child.define("x", 7);
      expect(child.resolve("x").slot).toBe(7);
    });
  });

  describe("binding kinds", () => {
    it("defineVar sets kind to var", () => {
      const scope = new Scope();
      scope.defineVar("v", 0);
      expect(scope.resolve("v").kind).toBe("var");
    });

    it("defineConst sets kind to const and marks constSlots", () => {
      const scope = new Scope();
      scope.defineConst("c", 2);
      expect(scope.resolve("c").kind).toBe("const");
      expect(scope.constSlots.has(2)).toBe(true);
    });

    it("defineFunction sets kind to function", () => {
      const scope = new Scope();
      scope.defineFunction("fn", 1);
      expect(scope.resolve("fn").kind).toBe("function");
    });
  });

  describe("isConst", () => {
    it("returns true for const-declared variables", () => {
      const scope = new Scope();
      scope.defineConst("PI", 0);
      expect(scope.isConst("PI")).toBe(true);
    });

    it("returns false for let/var-declared variables", () => {
      const scope = new Scope();
      scope.define("x", 0);
      scope.defineVar("y", 1);
      expect(scope.isConst("x")).toBe(false);
      expect(scope.isConst("y")).toBe(false);
    });

    it("returns false for undeclared variables", () => {
      const scope = new Scope();
      expect(scope.isConst("nope")).toBe(false);
    });
  });

  describe("upvalue capture across function boundary", () => {
    it("captures local from outer scope as upvalue when crossing function boundary", () => {
      const outer = new Scope();
      outer.define("captured", 3);
      const inner = new Scope(outer);
      inner.isFunctionBoundary = true;
      const result = inner.resolve("captured");
      expect(result.type).toBe("upvalue");
      expect(result.slot).toBe(0);
      expect(inner.upvalues).toHaveLength(1);
      expect(inner.upvalues[0].name).toBe("captured");
      expect(inner.upvalues[0].outerSlot).toBe(3);
    });

    it("reuses same upvalue slot for repeated captures of same variable", () => {
      const outer = new Scope();
      outer.define("x", 0);
      const inner = new Scope(outer);
      inner.isFunctionBoundary = true;
      const r1 = inner.resolve("x");
      const r2 = inner.resolve("x");
      expect(r1.slot).toBe(r2.slot);
      expect(inner.upvalues).toHaveLength(1);
    });

    it("does NOT capture as upvalue when no function boundary", () => {
      const outer = new Scope();
      outer.define("x", 0);
      const inner = new Scope(outer);
      const result = inner.resolve("x");
      expect(result.type).toBe("local");
    });
  });
});

describe("analyzeSimpleConstructor", () => {
  function makeConstructor(fields, params = 1) {
    const fn = new RegisterCompiledFunction("Ctor", params);
    for (const { name, source } of fields) {
      const nameIdx = fn.addConstant(name);
      fn.emit(ROP_LDA_THIS);
      fn.emit(ROP_STAR, fn.allocTemp());
      if (source.kind === "local") fn.emit(ROP_LDA_REG, source.index);
      else if (source.kind === "const") fn.emit(ROP_LDA_CONST, fn.addConstant(source.value));
      else if (source.kind === "undefined") fn.emit(ROP_LDA_UNDEFINED);
      const thisReg = fn.registerCount - 1;
      fn.emit(ROP_STA_PROP, thisReg, nameIdx);
    }
    fn.emit(ROP_LDA_UNDEFINED);
    fn.emit(ROP_RETURN);
    return fn;
  }

  it("detects simple constructor with field assignments from params", () => {
    const fn = makeConstructor([
      { name: "x", source: { kind: "local", index: 0 } },
      { name: "y", source: { kind: "local", index: 1 } },
    ], 2);

    const result = analyzeSimpleConstructor(fn);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("x");
    expect(result[1].name).toBe("y");
  });

  it("detects constructor with constant field initializer", () => {
    const fn = makeConstructor([
      { name: "count", source: { kind: "const", value: 0 } },
    ]);

    const result = analyzeSimpleConstructor(fn);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("count");
    expect(result[0].source.kind).toBe("const");
  });

  it("returns null for empty constructor", () => {
    const fn = new RegisterCompiledFunction("Empty", 0);
    expect(analyzeSimpleConstructor(fn)).toBeNull();
  });

  it("returns null for constructor with non-simple patterns (e.g. ADD)", () => {
    const fn = new RegisterCompiledFunction("Complex", 1);
    fn.emit(ROP_ADD, 0, 0);
    fn.emit(ROP_RETURN);
    expect(analyzeSimpleConstructor(fn)).toBeNull();
  });

  it("caches result on compiledFn.simpleConstructorInfo", () => {
    const fn = makeConstructor([
      { name: "a", source: { kind: "undefined" } },
    ]);
    const r1 = analyzeSimpleConstructor(fn);
    const r2 = analyzeSimpleConstructor(fn);
    expect(r1).toBe(r2);
  });
});
