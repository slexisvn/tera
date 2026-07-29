import { describe, it, expect, beforeEach } from "vitest";
import { RegisterBytecodeCompiler } from "../../src/bytecode/register/compiler/index.js";
import * as bytecode from "../../src/bytecode/register/ops/bytecode.js";
import {
  Program,
  ExpressionStatement,
  Literal,
  Identifier,
  BinaryExpression,
  UnaryExpression,
  LogicalExpression,
  AssignmentExpression,
  VarDeclaration,
  LetDeclaration,
  ConstDeclaration,
  IfStatement,
  WhileStatement,
  ForStatement,
  BlockStatement,
  ReturnStatement,
  CallExpression,
  MemberExpression,
  ObjectExpression,
  ConditionalExpression,
  FunctionDeclaration,
  DoWhileStatement,
  BreakStatement,
  ContinueStatement,
  UpdateExpression,
  CompoundAssignmentExpression,
  NewExpression,
  TemplateLiteral,
  ArrowFunctionExpression,
  FunctionExpression,
} from "../../src/frontend/ast/index.js";

function ops(func) {
  return func.instructions.map((i) => i.opcode);
}

function insAt(func, idx) {
  return func.instructions[idx];
}

describe("RegisterBytecodeCompiler", () => {
  let compiler;

  beforeEach(() => {
    compiler = new RegisterBytecodeCompiler();
  });

  describe("compile()", () => {
    it("rejects non-Program nodes", () => {
      expect(() => compiler.compile({ type: "Bogus" })).toThrow(
        "Expected Program node",
      );
    });

    it("compiles empty program", () => {
      const func = compiler.compile(Program([]));
      expect(func.name).toBe("<script>");
      expect(func.paramCount).toBe(0);
      const opcodes = ops(func);
      expect(opcodes).toEqual([bytecode.ROP_LDA_UNDEFINED, bytecode.ROP_RETURN]);
    });

    it("returns last expression value for trailing ExpressionStatement", () => {
      const ast = Program([ExpressionStatement(Literal(42, "number"))]);
      const func = compiler.compile(ast);
      const opcodes = ops(func);
      expect(opcodes[opcodes.length - 1]).toBe(bytecode.ROP_RETURN);
      expect(opcodes).not.toContain(bytecode.ROP_LDA_UNDEFINED);
    });

    it("emits LDA_UNDEFINED + RETURN when last stmt is not expression", () => {
      const ast = Program([VarDeclaration("x", Literal(1, "number"))]);
      const func = compiler.compile(ast);
      const opcodes = ops(func);
      const tail = opcodes.slice(-2);
      expect(tail).toEqual([bytecode.ROP_LDA_UNDEFINED, bytecode.ROP_RETURN]);
    });
  });

  describe("literals", () => {
    it("each kind emits the correct specialized opcode", () => {
      const cases = [
        [Literal(true, "boolean"), bytecode.ROP_LDA_TRUE],
        [Literal(false, "boolean"), bytecode.ROP_LDA_FALSE],
        [Literal(null, "null"), bytecode.ROP_LDA_NULL],
        [Literal(undefined, "undefined"), bytecode.ROP_LDA_UNDEFINED],
        [Literal(42, "number"), bytecode.ROP_LDA_CONST],
        [Literal("hi", "string"), bytecode.ROP_LDA_CONST],
      ];
      for (const [lit, expected] of cases) {
        const c = new RegisterBytecodeCompiler();
        const func = c.compile(Program([ExpressionStatement(lit)]));
        expect(ops(func)).toContain(expected);
      }
    });

    it("deduplicates same constant values", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(Literal(42, "number")),
          ExpressionStatement(Literal(42, "number")),
        ]),
      );
      const count = func.constants.filter((c) => c === 42).length;
      expect(count).toBe(1);
    });
  });

  describe("identifiers", () => {
    it("emits LDA_GLOBAL for unresolved identifier", () => {
      const func = compiler.compile(
        Program([ExpressionStatement(Identifier("console"))]),
      );
      expect(ops(func)).toContain(bytecode.ROP_LDA_GLOBAL);
      expect(func.constants).toContain("console");
    });

    it("emits LDA_REG for local variable", () => {
      const func = compiler.compile(
        Program([
          LetDeclaration("x", Literal(10, "number")),
          ExpressionStatement(Identifier("x")),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_LDA_REG);
    });

    it("emits LDA_GLOBAL for script-scope var", () => {
      const func = compiler.compile(
        Program([
          VarDeclaration("x", Literal(10, "number")),
          ExpressionStatement(Identifier("x")),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_LDA_GLOBAL);
    });
  });

  describe("binary expressions", () => {
    it("compiles all arithmetic operators", () => {
      const operators = [
        ["+", bytecode.ROP_ADD],
        ["-", bytecode.ROP_SUB],
        ["*", bytecode.ROP_MUL],
        ["/", bytecode.ROP_DIV],
        ["%", bytecode.ROP_MOD],
      ];
      for (const [op, expected] of operators) {
        const c = new RegisterBytecodeCompiler();
        const func = c.compile(
          Program([
            ExpressionStatement(
              BinaryExpression(op, Literal(1, "number"), Literal(2, "number")),
            ),
          ]),
        );
        expect(ops(func)).toContain(expected);
      }
    });

    it("compiles comparison operators", () => {
      const operators = [
        ["===", bytecode.ROP_EQ],
        ["!==", bytecode.ROP_NEQ],
        ["<", bytecode.ROP_LT],
        [">", bytecode.ROP_GT],
        ["<=", bytecode.ROP_LTE],
        [">=", bytecode.ROP_GTE],
        ["==", bytecode.ROP_LOOSE_EQ],
        ["!=", bytecode.ROP_LOOSE_NEQ],
      ];
      for (const [op, expected] of operators) {
        const c = new RegisterBytecodeCompiler();
        const func = c.compile(
          Program([
            ExpressionStatement(
              BinaryExpression(op, Literal(1, "number"), Literal(2, "number")),
            ),
          ]),
        );
        expect(ops(func)).toContain(expected);
      }
    });

    it("compiles bitwise operators", () => {
      const operators = [
        ["&", bytecode.ROP_BITAND],
        ["|", bytecode.ROP_BITOR],
        ["^", bytecode.ROP_BITXOR],
        ["<<", bytecode.ROP_SHL],
        [">>", bytecode.ROP_SHR],
        [">>>", bytecode.ROP_USHR],
      ];
      for (const [op, expected] of operators) {
        const c = new RegisterBytecodeCompiler();
        const func = c.compile(
          Program([
            ExpressionStatement(
              BinaryExpression(op, Literal(1, "number"), Literal(2, "number")),
            ),
          ]),
        );
        expect(ops(func)).toContain(expected);
      }
    });

    it("throws on unknown binary operator", () => {
      expect(() =>
        compiler.compile(
          Program([
            ExpressionStatement(
              BinaryExpression(
                "???",
                Literal(1, "number"),
                Literal(2, "number"),
              ),
            ),
          ]),
        ),
      ).toThrow("Unknown binary operator");
    });

    it("allocates and frees temp registers for operands", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            BinaryExpression("+", Literal(1, "number"), Literal(2, "number")),
          ),
        ]),
      );
      const starCount = ops(func).filter((o) => o === bytecode.ROP_STAR).length;
      expect(starCount).toBeGreaterThanOrEqual(2);
    });

    it("uses feedback slot", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            BinaryExpression("+", Literal(1, "number"), Literal(2, "number")),
          ),
        ]),
      );
      expect(func.feedbackSlotCount).toBeGreaterThan(0);
    });
  });

  describe("unary expressions", () => {
    it("maps each operator to the correct opcode", () => {
      const cases = [
        ["!", bytecode.ROP_NOT],
        ["-", bytecode.ROP_NEG],
        ["typeof", bytecode.ROP_TYPEOF],
        ["~", bytecode.ROP_BITNOT],
        ["void", bytecode.ROP_VOID],
      ];
      for (const [op, expected] of cases) {
        const c = new RegisterBytecodeCompiler();
        const func = c.compile(
          Program([ExpressionStatement(UnaryExpression(op, Literal(1, "number")))]),
        );
        expect(ops(func)).toContain(expected);
      }
    });

    it("throws on unknown unary operator", () => {
      expect(() =>
        compiler.compile(
          Program([
            ExpressionStatement(UnaryExpression("@", Literal(1, "number"))),
          ]),
        ),
      ).toThrow("Unknown unary operator");
    });
  });

  describe("logical expressions", () => {
    it("compiles && with short-circuit jump", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            LogicalExpression(
              "&&",
              Literal(true, "boolean"),
              Literal(false, "boolean"),
            ),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_JUMP_IF_FALSE);
    });

    it("compiles || with short-circuit jump", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            LogicalExpression(
              "||",
              Literal(false, "boolean"),
              Literal(true, "boolean"),
            ),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_JUMP_IF_TRUE);
    });

    it("patches jump target correctly for &&", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            LogicalExpression(
              "&&",
              Literal(true, "boolean"),
              Literal(42, "number"),
            ),
          ),
        ]),
      );
      const jumpIdx = ops(func).indexOf(bytecode.ROP_JUMP_IF_FALSE);
      const jumpTarget = insAt(func, jumpIdx).operands[0];
      expect(jumpTarget).toBe(func.instructions.length - 1);
    });
  });

  describe("variable declarations", () => {
    it("var without init emits nothing (no unnecessary load)", () => {
      const func = compiler.compile(Program([VarDeclaration("x", null)]));
      expect(ops(func)).not.toContain(bytecode.ROP_LDA_CONST);
    });

    it("let without init initializes to undefined", () => {
      const func = compiler.compile(Program([LetDeclaration("y", null)]));
      const undIdx = ops(func).indexOf(bytecode.ROP_LDA_UNDEFINED);
      const starIdx = ops(func).indexOf(bytecode.ROP_STAR);
      expect(undIdx).toBeLessThan(starIdx);
    });

    it("binding kind recorded correctly per declaration type", () => {
      const func = compiler.compile(
        Program([
          LetDeclaration("b", Literal(2, "number")),
          ConstDeclaration("c", Literal(3, "number")),
        ]),
      );
      const bIdx = func.localNames.indexOf("b");
      const cIdx = func.localNames.indexOf("c");
      expect(func.localBindingKinds[bIdx]).toBe("let");
      expect(func.localBindingKinds[cIdx]).toBe("const");
    });

    it("script-scope var uses global cells not locals", () => {
      const func = compiler.compile(
        Program([
          VarDeclaration("a", Literal(1, "number")),
        ]),
      );
      expect(func.localNames.indexOf("a")).toBe(-1);
      expect(ops(func)).toContain(bytecode.ROP_STA_GLOBAL);
    });
  });

  describe("assignment expressions", () => {
    it("compiles assignment to global", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            AssignmentExpression(Identifier("x"), Literal(5, "number")),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_STA_GLOBAL);
    });

    it("compiles assignment to named property", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            AssignmentExpression(
              MemberExpression(Identifier("obj"), "prop", false),
              Literal(10, "number"),
            ),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_STA_PROP);
    });

    it("compiles assignment to computed property", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            AssignmentExpression(
              MemberExpression(
                Identifier("arr"),
                Literal(0, "number"),
                true,
              ),
              Literal(10, "number"),
            ),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_STA_INDEX);
    });

    it("throws on assignment to const", () => {
      expect(() =>
        compiler.compile(
          Program([
            ConstDeclaration("c", Literal(1, "number")),
            ExpressionStatement(
              AssignmentExpression(Identifier("c"), Literal(2, "number")),
            ),
          ]),
        ),
      ).toThrow("Assignment to constant variable");
    });
  });

  describe("if statements", () => {
    it("compiles if without else", () => {
      const func = compiler.compile(
        Program([
          IfStatement(
            Literal(true, "boolean"),
            ExpressionStatement(Literal(1, "number")),
            null,
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_JUMP_IF_FALSE);
      expect(ops(func)).not.toContain(bytecode.ROP_JUMP);
    });

    it("compiles if-else", () => {
      const func = compiler.compile(
        Program([
          IfStatement(
            Literal(true, "boolean"),
            ExpressionStatement(Literal(1, "number")),
            ExpressionStatement(Literal(2, "number")),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_JUMP_IF_FALSE);
      expect(ops(func)).toContain(bytecode.ROP_JUMP);
    });

    it("patches jump targets correctly for if-else", () => {
      const func = compiler.compile(
        Program([
          IfStatement(
            Literal(true, "boolean"),
            ExpressionStatement(Literal(1, "number")),
            ExpressionStatement(Literal(2, "number")),
          ),
        ]),
      );
      const jumpIfFalseIdx = ops(func).indexOf(bytecode.ROP_JUMP_IF_FALSE);
      const jumpIdx = ops(func).indexOf(bytecode.ROP_JUMP);
      const elseTarget = insAt(func, jumpIfFalseIdx).operands[0];
      expect(elseTarget).toBe(jumpIdx + 1);
    });
  });

  describe("while statements", () => {
    it("emits loop structure with condition check and back-jump", () => {
      const func = compiler.compile(
        Program([
          WhileStatement(
            Literal(true, "boolean"),
            ExpressionStatement(Literal(1, "number")),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_JUMP_IF_FALSE);
      expect(ops(func)).toContain(bytecode.ROP_JUMP);
    });

    it("back-jump points to loop start", () => {
      const func = compiler.compile(
        Program([
          WhileStatement(
            Literal(true, "boolean"),
            ExpressionStatement(Literal(1, "number")),
          ),
        ]),
      );
      const jumpIdx = ops(func).lastIndexOf(bytecode.ROP_JUMP);
      expect(insAt(func, jumpIdx).operands[0]).toBe(0);
    });
  });

  describe("for statements", () => {
    it("compiles for loop with init, test, update", () => {
      const func = compiler.compile(
        Program([
          ForStatement(
            VarDeclaration("i", Literal(0, "number")),
            BinaryExpression("<", Identifier("i"), Literal(10, "number")),
            UpdateExpression("++", Identifier("i"), false),
            ExpressionStatement(Identifier("i")),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_JUMP_IF_FALSE);
      expect(ops(func)).toContain(bytecode.ROP_JUMP);
      expect(ops(func)).toContain(bytecode.ROP_LT);
    });
  });

  describe("do-while statements", () => {
    it("emits body before condition check", () => {
      const func = compiler.compile(
        Program([
          DoWhileStatement(
            Literal(false, "boolean"),
            ExpressionStatement(Literal(1, "number")),
          ),
        ]),
      );
      const bodyIdx = ops(func).indexOf(bytecode.ROP_LDA_CONST);
      const condIdx = ops(func).indexOf(bytecode.ROP_LDA_FALSE);
      expect(bodyIdx).toBeLessThan(condIdx);
    });
  });

  describe("break and continue", () => {
    it("compiles break in while loop", () => {
      const func = compiler.compile(
        Program([
          WhileStatement(Literal(true, "boolean"), BreakStatement()),
        ]),
      );
      const jumps = ops(func).filter((o) => o === bytecode.ROP_JUMP);
      expect(jumps.length).toBeGreaterThanOrEqual(2);
    });

    it("compiles continue in while loop", () => {
      const func = compiler.compile(
        Program([
          WhileStatement(Literal(true, "boolean"), ContinueStatement()),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_JUMP);
    });
  });

  describe("call expressions", () => {
    it("compiles simple function call", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            CallExpression(Identifier("foo"), [Literal(1, "number")]),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_CALL);
    });

    it("compiles method call", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            CallExpression(
              MemberExpression(Identifier("obj"), "method", false),
              [Literal(1, "number")],
            ),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_CALL_METHOD);
    });

    it("compiles call with no arguments", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            CallExpression(Identifier("fn"), []),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_CALL);
      const callIdx = ops(func).indexOf(bytecode.ROP_CALL);
      const callInstr = insAt(func, callIdx);
      expect(callInstr.operands).toContain(0);
    });
  });

  describe("new expressions", () => {
    it("compiles new expression", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            NewExpression(Identifier("Foo"), [Literal(1, "number")]),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_NEW);
    });
  });

  describe("member expressions", () => {
    it("compiles named property access", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            MemberExpression(Identifier("obj"), "prop", false),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_LDA_PROP);
    });

    it("compiles computed property access", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            MemberExpression(Identifier("arr"), Literal(0, "number"), true),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_LDA_INDEX);
    });
  });

  describe("object expressions", () => {
    it("object with properties emits NEW_OBJECT then STA_PROP per key", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            ObjectExpression([
              { key: "a", value: Literal(1, "number") },
              { key: "b", value: Literal(2, "number") },
            ]),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_NEW_OBJECT);
      const staPropCount = ops(func).filter((o) => o === bytecode.ROP_STA_PROP).length;
      expect(staPropCount).toBe(2);
    });
  });

  describe("conditional expressions", () => {
    it("ternary emits both branches with correct jump structure", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            ConditionalExpression(
              Literal(true, "boolean"),
              Literal(1, "number"),
              Literal(2, "number"),
            ),
          ),
        ]),
      );
      const jifIdx = ops(func).indexOf(bytecode.ROP_JUMP_IF_FALSE);
      const jmpIdx = ops(func).indexOf(bytecode.ROP_JUMP);
      expect(jifIdx).toBeLessThan(jmpIdx);
      const elseTarget = insAt(func, jifIdx).operands[0];
      expect(elseTarget).toBe(jmpIdx + 1);
    });
  });

  describe("update expressions", () => {
    it("compiles postfix ++", () => {
      const func = compiler.compile(
        Program([
          VarDeclaration("x", Literal(0, "number")),
          ExpressionStatement(UpdateExpression("++", Identifier("x"), false)),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_ADD);
    });

    it("compiles prefix --", () => {
      const func = compiler.compile(
        Program([
          VarDeclaration("x", Literal(0, "number")),
          ExpressionStatement(UpdateExpression("--", Identifier("x"), true)),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_SUB);
    });
  });

  describe("compound assignment", () => {
    it("compiles +=", () => {
      const func = compiler.compile(
        Program([
          VarDeclaration("x", Literal(1, "number")),
          ExpressionStatement(
            CompoundAssignmentExpression(
              "+",
              Identifier("x"),
              Literal(2, "number"),
            ),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_ADD);
    });
  });

  describe("function declarations", () => {
    it("compiles function declaration without upvalues as LDA_CONST", () => {
      const func = compiler.compile(
        Program([
          FunctionDeclaration(
            "greet",
            [],
            BlockStatement([ReturnStatement(Literal("hi", "string"))]),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_LDA_CONST);
    });

    it("compiles function declaration with upvalue as MAKE_CLOSURE", () => {
      const func = compiler.compile(
        Program([
          LetDeclaration("x", Literal(1, "number")),
          FunctionDeclaration(
            "getX",
            [],
            BlockStatement([ReturnStatement(Identifier("x"))]),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_MAKE_CLOSURE);
    });

    it("creates inner function as constant", () => {
      const func = compiler.compile(
        Program([
          FunctionDeclaration(
            "add",
            ["a", "b"],
            BlockStatement([
              ReturnStatement(
                BinaryExpression("+", Identifier("a"), Identifier("b")),
              ),
            ]),
          ),
        ]),
      );
      const innerFn = func.constants.find(
        (c) => c instanceof bytecode.RegisterCompiledFunction,
      );
      expect(innerFn).toBeDefined();
      expect(innerFn.name).toBe("add");
      expect(innerFn.paramCount).toBe(2);
    });

    it("inner function emits RETURN", () => {
      const func = compiler.compile(
        Program([
          FunctionDeclaration(
            "f",
            [],
            BlockStatement([ReturnStatement(Literal(1, "number"))]),
          ),
        ]),
      );
      const innerFn = func.constants.find(
        (c) => c instanceof bytecode.RegisterCompiledFunction,
      );
      const innerOps = innerFn.instructions.map((i) => i.opcode);
      expect(innerOps).toContain(bytecode.ROP_RETURN);
    });
  });

  describe("arrow functions", () => {
    it("compiles arrow function expression body", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            ArrowFunctionExpression(["x"], Literal(42, "number"), true),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_LDA_CONST);
      const innerFn = func.constants.find(
        (c) => c instanceof bytecode.RegisterCompiledFunction,
      );
      expect(innerFn).toBeDefined();
      expect(innerFn.isArrow).toBe(true);
    });

    it("compiles arrow function block body", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            ArrowFunctionExpression(
              ["x"],
              BlockStatement([ReturnStatement(Identifier("x"))]),
              false,
            ),
          ),
        ]),
      );
      const innerFn = func.constants.find(
        (c) => c instanceof bytecode.RegisterCompiledFunction,
      );
      expect(innerFn).toBeDefined();
    });
  });

  describe("function expressions", () => {
    it("compiles named function expression", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            FunctionExpression(
              "myFn",
              ["a"],
              BlockStatement([ReturnStatement(Identifier("a"))]),
            ),
          ),
        ]),
      );
      const innerFn = func.constants.find(
        (c) => c instanceof bytecode.RegisterCompiledFunction,
      );
      expect(innerFn).toBeDefined();
      expect(innerFn.name).toBe("myFn");
    });
  });

  describe("template literals", () => {
    it("compiles template literal with expressions", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            TemplateLiteral(["hello ", "!"], [Identifier("name")]),
          ),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_ADD);
    });
  });

  describe("nested expressions", () => {
    it("compiles nested binary expressions", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            BinaryExpression(
              "+",
              BinaryExpression("+", Literal(1, "number"), Literal(2, "number")),
              Literal(3, "number"),
            ),
          ),
        ]),
      );
      const addCount = ops(func).filter((o) => o === bytecode.ROP_ADD).length;
      expect(addCount).toBe(2);
    });
  });

  describe("scope management", () => {
    it("creates new scope for block statements", () => {
      const func = compiler.compile(
        Program([
          LetDeclaration("x", Literal(1, "number")),
          BlockStatement([
            LetDeclaration("y", Literal(2, "number")),
            ExpressionStatement(Identifier("y")),
          ]),
        ]),
      );
      expect(func.localNames).toContain("x");
      expect(func.localNames).toContain("y");
    });

    it("outer variable accessible in inner block", () => {
      const func = compiler.compile(
        Program([
          LetDeclaration("x", Literal(1, "number")),
          BlockStatement([ExpressionStatement(Identifier("x"))]),
        ]),
      );
      expect(ops(func)).toContain(bytecode.ROP_LDA_REG);
    });
  });

  describe("register allocation", () => {
    it("registerCount grows with locals", () => {
      const func = compiler.compile(
        Program([
          LetDeclaration("a", Literal(1, "number")),
          LetDeclaration("b", Literal(2, "number")),
          LetDeclaration("c", Literal(3, "number")),
        ]),
      );
      expect(func.registerCount).toBeGreaterThanOrEqual(3);
    });

    it("reuses freed temp registers", () => {
      const func = compiler.compile(
        Program([
          ExpressionStatement(
            BinaryExpression("+", Literal(1, "number"), Literal(2, "number")),
          ),
          ExpressionStatement(
            BinaryExpression("*", Literal(3, "number"), Literal(4, "number")),
          ),
        ]),
      );
      const singleExprCompiler = new RegisterBytecodeCompiler();
      const singleFunc = singleExprCompiler.compile(
        Program([
          ExpressionStatement(
            BinaryExpression("+", Literal(1, "number"), Literal(2, "number")),
          ),
        ]),
      );
      expect(func.registerCount).toBe(singleFunc.registerCount);
    });
  });

  describe("disassemble", () => {
    it("returns readable disassembly string", () => {
      const func = compiler.compile(
        Program([ExpressionStatement(Literal(42, "number"))]),
      );
      const dis = func.disassemble();
      expect(dis).toContain("<script>");
      expect(dis).toContain("LdaConst");
      expect(dis).toContain("Return");
    });
  });
});
