import { describe, it, expect } from "vitest";
import { BaselineCompiler } from "../../src/optimizing/baseline/compiler.js";
import {
  RegisterCompiledFunction,
  RegisterInstruction,
  ROP_LDA_CONST,
  ROP_STAR,
  ROP_ADD,
  ROP_RETURN,
  ROP_LDA_UNDEFINED,
  ROP_CALL_METHOD,
  ROP_TRY_START,
  ROP_THROW,
  ROP_CALL_SPREAD,
  ROP_REST_ARGS,
  ROP_DEFINE_ACCESSOR,
  ROP_MAKE_CLOSURE,
  ROP_JUMP,
  ROP_JUMP_IF_FALSE,
  ROP_SUB,
  ROP_MUL,
  ROP_LT,
  ROP_NOT,
  ROP_NEW_OBJECT,
  ROP_LDA_THIS,
  ROP_LDA_TRUE,
  ROP_LDA_FALSE,
  ROP_LDA_NULL,
  ROP_LDA_REG,
  ROP_MOV,
  ROP_EQ,
  ROP_NEQ,
} from "../../src/bytecode/register/ops/bytecode.js";

function makeSimpleFn(name, instrs, opts = {}) {
  const fn = new RegisterCompiledFunction(name, opts.paramCount || 0);
  fn.registerCount = opts.registerCount || 4;
  fn.constants = opts.constants || [];
  fn.instructions = instrs;
  return fn;
}

function makeMockInterpreter() {
  return {
    icManager: { getOrCreate: () => ({ lookup: () => ({ hit: false }), lookupCall: () => {} }) },
    globalCells: new Map(),
    callFunctionValue: () => null,
  };
}

describe("BaselineCompiler", () => {
  const compiler = new BaselineCompiler();

  describe("compile rejection", () => {
    it("rejects empty instructions", () => {
      const fn = makeSimpleFn("empty", []);
      expect(compiler.compile(fn, makeMockInterpreter())).toBeNull();
    });

    it("rejects functions with > 1000 instructions", () => {
      const instrs = Array.from({ length: 1001 }, () => new RegisterInstruction(ROP_LDA_UNDEFINED));
      const fn = makeSimpleFn("huge", instrs);
      expect(compiler.compile(fn, makeMockInterpreter())).toBeNull();
    });

    it("compiles functions containing ROP_CALL_METHOD", () => {
      const fn = makeSimpleFn("method", [
        new RegisterInstruction(ROP_CALL_METHOD, 0, 0, 0, 0),
        new RegisterInstruction(ROP_RETURN),
      ]);
      expect(compiler.compile(fn, makeMockInterpreter())).not.toBeNull();
    });

    it("rejects functions containing try/throw", () => {
      for (const op of [ROP_TRY_START, ROP_THROW]) {
        const fn = makeSimpleFn("tryCatch", [
          new RegisterInstruction(op),
          new RegisterInstruction(ROP_RETURN),
        ]);
        expect(compiler.compile(fn, makeMockInterpreter())).toBeNull();
      }
    });

    it("rejects functions containing spread/rest/defineAccessor", () => {
      for (const op of [ROP_CALL_SPREAD, ROP_REST_ARGS, ROP_DEFINE_ACCESSOR]) {
        const fn = makeSimpleFn("spread", [
          new RegisterInstruction(op, 0, 0),
          new RegisterInstruction(ROP_RETURN),
        ]);
        expect(compiler.compile(fn, makeMockInterpreter())).toBeNull();
      }
    });

    it("rejects closures with upvalues", () => {
      const innerFn = new RegisterCompiledFunction("inner", 0);
      innerFn.upvalues = [{ isLocal: true, index: 0 }];
      const fn = makeSimpleFn("outer", [
        new RegisterInstruction(ROP_MAKE_CLOSURE, 0),
        new RegisterInstruction(ROP_RETURN),
      ], { constants: [innerFn] });
      expect(compiler.compile(fn, makeMockInterpreter())).toBeNull();
    });
  });

  describe("successful compilation", () => {
    it("compiles simple return-constant function and returns callable with _isBaseline flag", () => {
      const fn = makeSimpleFn("retConst", [
        new RegisterInstruction(ROP_LDA_CONST, 0),
        new RegisterInstruction(ROP_RETURN),
      ], { constants: [42] });

      const result = compiler.compile(fn, makeMockInterpreter());
      expect(result).not.toBeNull();
      expect(result._isBaseline).toBe(true);
      expect(typeof result).toBe("function");
    });

    it("creates fast-call variants (_call0, _call1, _call2, _call3)", () => {
      const fn = makeSimpleFn("fastcall", [
        new RegisterInstruction(ROP_LDA_UNDEFINED),
        new RegisterInstruction(ROP_RETURN),
      ]);

      const result = compiler.compile(fn, makeMockInterpreter());
      expect(typeof result._call0).toBe("function");
      expect(typeof result._call1).toBe("function");
      expect(typeof result._call2).toBe("function");
      expect(typeof result._call3).toBe("function");
    });
  });

  describe("generateBody code generation", () => {
    it("generates switch/case dispatch loop", () => {
      const fn = makeSimpleFn("body", [
        new RegisterInstruction(ROP_LDA_UNDEFINED),
        new RegisterInstruction(ROP_RETURN),
      ]);
      const body = compiler.generateBody(fn);
      expect(body).toContain("switch(pc)");
      expect(body).toContain("case 0:");
      expect(body).toContain("case 1:");
    });

    it("emits jump as pc assignment + continue", () => {
      const fn = makeSimpleFn("jump", [
        new RegisterInstruction(ROP_JUMP, 2),
        new RegisterInstruction(ROP_LDA_UNDEFINED),
        new RegisterInstruction(ROP_RETURN),
      ]);
      const body = compiler.generateBody(fn);
      expect(body).toContain("pc=2;continue L;");
    });

    it("emits conditional branch for JUMP_IF_FALSE", () => {
      const fn = makeSimpleFn("branch", [
        new RegisterInstruction(ROP_JUMP_IF_FALSE, 2, 0),
        new RegisterInstruction(ROP_LDA_UNDEFINED),
        new RegisterInstruction(ROP_RETURN),
      ]);
      const body = compiler.generateBody(fn);
      expect(body).toContain("toBool(acc)");
      expect(body).toContain("pc=2;continue L;");
    });

    it("emits SMI fast path for ADD with tag check", () => {
      const fn = makeSimpleFn("add", [
        new RegisterInstruction(ROP_ADD, 1, 0),
        new RegisterInstruction(ROP_RETURN),
      ]);
      const body = compiler.generateBody(fn);
      expect(body).toContain("&15)===0");
      expect(body).toContain("$.add(");
    });

    it("emits return acc for ROP_RETURN", () => {
      const fn = makeSimpleFn("ret", [new RegisterInstruction(ROP_RETURN)]);
      const body = compiler.generateBody(fn);
      expect(body).toContain("return acc;");
    });
  });

  describe("emitOp per opcode", () => {
    const cases = [
      [ROP_LDA_UNDEFINED, [], "$.u"],
      [ROP_LDA_NULL, [], "$.n"],
      [ROP_LDA_TRUE, [], "$.t"],
      [ROP_LDA_FALSE, [], "$.f"],
      [ROP_LDA_THIS, [], "acc=tv"],
      [ROP_LDA_REG, [2], "r[2]"],
      [ROP_STAR, [3], "r[3]=acc"],
      [ROP_MOV, [0, 1], "r[0]=r[1]"],
      [ROP_NOT, [0], "$.not(acc"],
      [ROP_NEW_OBJECT, [], "$.newObj()"],
    ];

    for (const [opcode, operands, expected] of cases) {
      it(`emits correct code for opcode 0x${opcode.toString(16)}`, () => {
        const instr = new RegisterInstruction(opcode, ...operands);
        const code = compiler.emitOp(instr, 0, makeSimpleFn("t", []), false, null);
        expect(code).toContain(expected);
      });
    }
  });
});

