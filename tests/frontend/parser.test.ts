import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser/index.js";
import { NodeType } from "../../src/frontend/ast/index.js";

function parseExpr(src) {
  const ast = parse(src);
  expect(ast.type).toBe(NodeType.Program);
  expect(ast.body).toHaveLength(1);
  expect(ast.body[0].type).toBe(NodeType.ExpressionStatement);
  return ast.body[0].expression;
}

function parseStmt(src) {
  const ast = parse(src);
  expect(ast.type).toBe(NodeType.Program);
  expect(ast.body).toHaveLength(1);
  return ast.body[0];
}

describe("Parser", () => {
  describe("literals", () => {
    it("all literal types parse with correct kind and value", () => {
      const cases = [
        ["42", 42, "number"],
        ["3.14", 3.14, "number"],
        ['"hello"', "hello", "string"],
        ["'world'", "world", "string"],
        ["true", true, "boolean"],
        ["false", false, "boolean"],
        ["null", null, "null"],
        ["undefined", undefined, "undefined"],
      ];
      for (const [src, value, kind] of cases) {
        const expr = parseExpr(src);
        expect(expr.type).toBe(NodeType.Literal);
        expect(expr.kind).toBe(kind);
        if (kind === "number" && !Number.isInteger(value)) {
          expect(expr.value).toBeCloseTo(value);
        } else {
          expect(expr.value).toBe(value);
        }
      }
    });
  });

  describe("binary expressions", () => {
    it("all binary operators", () => {
      const ops = [
        "+", "-", "*", "/", "%", "**",
        "==", "!=", "===", "!==", "<", ">", "<=", ">=",
        "&", "|", "^", "<<", ">>", ">>>",
        "instanceof", "in",
      ];
      for (const op of ops) {
        const expr = parseExpr(`a ${op} b`);
        expect(expr.type).toBe(NodeType.BinaryExpression);
        expect(expr.op).toBe(op);
      }
    });

    it("precedence mul over add", () => {
      const expr = parseExpr("1 + 2 * 3");
      expect(expr.op).toBe("+");
      expect(expr.right.op).toBe("*");
    });

    it("precedence with parens", () => {
      const expr = parseExpr("(1 + 2) * 3");
      expect(expr.op).toBe("*");
      expect(expr.left.op).toBe("+");
    });

    it("exponentiation right associative", () => {
      const expr = parseExpr("2 ** 3 ** 4");
      expect(expr.op).toBe("**");
      expect(expr.right.op).toBe("**");
    });
  });

  describe("logical expressions", () => {
    it("logical operators", () => {
      for (const op of ["&&", "||"]) {
        const expr = parseExpr(`a ${op} b`);
        expect(expr.type).toBe(NodeType.LogicalExpression);
        expect(expr.op).toBe(op);
      }
    });

    it("nullish coalescing", () => {
      expect(parseExpr("a ?? b").type).toBe(
        NodeType.NullishCoalescingExpression,
      );
    });
  });

  describe("unary expressions", () => {
    it("all unary operators", () => {
      const cases = [
        ["-x", "-"], ["+x", "+"], ["!x", "!"], ["~x", "~"],
        ["typeof x", "typeof"], ["void 0", "void"], ["delete obj.x", "delete"],
      ];
      for (const [src, op] of cases) {
        const expr = parseExpr(src);
        expect(expr.type).toBe(NodeType.UnaryExpression);
        expect(expr.op).toBe(op);
      }
    });
  });

  describe("sequence expressions", () => {
    it("parses a parenthesized comma sequence", () => {
      const expr = parseExpr("(a, b, c)");
      expect(expr.type).toBe(NodeType.SequenceExpression);
      expect(expr.expressions).toHaveLength(3);
    });

    it("does not treat call arguments as a sequence", () => {
      const expr = parseExpr("f(a, b)");
      expect(expr.type).toBe(NodeType.CallExpression);
      expect(expr.args).toHaveLength(2);
    });

    it("does not treat array elements as a sequence", () => {
      const expr = parseExpr("[a, b]");
      expect(expr.type).toBe(NodeType.ArrayExpression);
      expect(expr.elements).toHaveLength(2);
    });
  });

  describe("update expressions", () => {
    it("prefix and postfix variants", () => {
      const cases = [
        ["++x", "++", true], ["--x", "--", true],
        ["x++", "++", false], ["x--", "--", false],
      ];
      for (const [src, op, prefix] of cases) {
        const expr = parseExpr(src);
        expect(expr.type).toBe(NodeType.UpdateExpression);
        expect(expr.op).toBe(op);
        expect(expr.prefix).toBe(prefix);
      }
    });
  });

  describe("assignment", () => {
    it("simple assignment", () => {
      const expr = parseExpr("x = 1");
      expect(expr).toMatchObject({
        type: NodeType.AssignmentExpression,
        target: { type: NodeType.Identifier, name: "x" },
        value: { type: NodeType.Literal, value: 1 },
      });
    });

    it("compound assignments", () => {
      for (const op of [
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        ">>>=",
        "**=",
      ]) {
        const expr = parseExpr(`x ${op} 1`);
        expect(expr.type).toBe(NodeType.CompoundAssignmentExpression);
        expect(expr.op).toBe(op.slice(0, -1));
      }
    });

    it("member assignment", () => {
      const expr = parseExpr("a.b = 1");
      expect(expr.target.type).toBe(NodeType.MemberExpression);
    });
  });

  describe("member expressions", () => {
    it("dot access", () => {
      const expr = parseExpr("a.b");
      expect(expr).toMatchObject({
        type: NodeType.MemberExpression,
        object: { name: "a" },
        property: "b",
        computed: false,
      });
    });

    it("computed access", () => {
      const expr = parseExpr("a[0]");
      expect(expr).toMatchObject({
        type: NodeType.MemberExpression,
        computed: true,
      });
    });

    it("chained", () => {
      const expr = parseExpr("a.b.c");
      expect(expr.type).toBe(NodeType.MemberExpression);
      expect(expr.object.type).toBe(NodeType.MemberExpression);
    });

    it("optional member", () => {
      const expr = parseExpr("a?.b");
      expect(expr.type).toBe(NodeType.OptionalMemberExpression);
    });

    it("optional computed", () => {
      const expr = parseExpr("a?.[0]");
      expect(expr.type).toBe(NodeType.OptionalMemberExpression);
    });
  });

  describe("call expressions", () => {
    it("no args", () => {
      const expr = parseExpr("foo()");
      expect(expr).toMatchObject({
        type: NodeType.CallExpression,
        callee: { name: "foo" },
        args: [],
      });
    });

    it("with args", () => {
      const expr = parseExpr("foo(1, 2, 3)");
      expect(expr.args).toHaveLength(3);
    });

    it("chained calls", () => {
      const expr = parseExpr("a()()");
      expect(expr.type).toBe(NodeType.CallExpression);
      expect(expr.callee.type).toBe(NodeType.CallExpression);
    });

    it("member call", () => {
      const expr = parseExpr("a.b(1)");
      expect(expr.callee.type).toBe(NodeType.MemberExpression);
    });

    it("optional call", () => {
      const expr = parseExpr("a?.(1)");
      expect(expr.type).toBe(NodeType.OptionalCallExpression);
    });

    it("spread in args", () => {
      const expr = parseExpr("foo(...args)");
      expect(expr.args[0].type).toBe(NodeType.SpreadElement);
    });
  });

  describe("new expression", () => {
    it("new with args", () => {
      const expr = parseExpr("new Foo(1)");
      expect(expr).toMatchObject({
        type: NodeType.NewExpression,
        callee: { name: "Foo" },
      });
      expect(expr.args).toHaveLength(1);
    });

    it("new without args", () => {
      const expr = parseExpr("new Foo");
      expect(expr.type).toBe(NodeType.NewExpression);
      expect(expr.args).toHaveLength(0);
    });

    it("new with member", () => {
      const expr = parseExpr("new a.B()");
      expect(expr.callee.type).toBe(NodeType.MemberExpression);
    });
  });

  describe("conditional expression", () => {
    it("ternary", () => {
      const expr = parseExpr("a ? b : c");
      expect(expr).toMatchObject({
        type: NodeType.ConditionalExpression,
        test: { name: "a" },
        consequent: { name: "b" },
        alternate: { name: "c" },
      });
    });
  });

  describe("array expression", () => {
    it("array with elements", () => {
      const expr = parseExpr("[1, 2, 3]");
      expect(expr.elements).toHaveLength(3);
    });

    it("array with spread", () => {
      const expr = parseExpr("[...a]");
      expect(expr.elements[0].type).toBe(NodeType.SpreadElement);
    });
  });

  describe("object expression", () => {
    it("key value pairs", () => {
      const ast = parse("x = { a: 1, b: 2 }");
      const expr = ast.body[0].expression.value;
      expect(expr.properties).toHaveLength(2);
      expect(expr.properties[0].key).toBe("a");
    });

    it("shorthand property", () => {
      const ast = parse("x = { a }");
      const prop = ast.body[0].expression.value.properties[0];
      expect(prop.key).toBe("a");
      expect(prop.value.type).toBe(NodeType.Identifier);
    });

    it("computed property", () => {
      const ast = parse("x = { [k]: 1 }");
      const prop = ast.body[0].expression.value.properties[0];
      expect(prop.computed).toBe(true);
    });

    it("spread property", () => {
      const ast = parse("x = { ...a }");
      const prop = ast.body[0].expression.value.properties[0];
      expect(prop.spread).toBe(true);
    });

    it("method shorthand", () => {
      const ast = parse("x = { foo(a) { return a } }");
      const prop = ast.body[0].expression.value.properties[0];
      expect(prop.value.type).toBe(NodeType.FunctionExpression);
    });

    it("getter and setter", () => {
      const ast = parse("x = { get a() { return 1 }, set a(v) { } }");
      const props = ast.body[0].expression.value.properties;
      expect(props[0].kind).toBe("get");
      expect(props[1].kind).toBe("set");
    });
  });

  describe("arrow functions", () => {
    it("single param no parens", () => {
      const expr = parseExpr("x => x + 1");
      expect(expr).toMatchObject({
        type: NodeType.ArrowFunctionExpression,
        params: ["x"],
        isExpression: true,
      });
    });

    it("multi params", () => {
      const expr = parseExpr("(a, b) => a + b");
      expect(expr.params).toEqual(["a", "b"]);
      expect(expr.isExpression).toBe(true);
    });

    it("no params", () => {
      const expr = parseExpr("() => 42");
      expect(expr.params).toEqual([]);
    });

    it("block body", () => {
      const expr = parseExpr("(x) => { return x }");
      expect(expr.isExpression).toBe(false);
      expect(expr.body.type).toBe(NodeType.BlockStatement);
    });

    it("default params", () => {
      const expr = parseExpr("(a, b = 1) => a + b");
      expect(expr.params[1]).toHaveProperty("default");
    });

    it("rest params", () => {
      const expr = parseExpr("(...args) => args");
      expect(expr.params[0]).toMatchObject({ name: "args", rest: true });
    });
  });

  describe("function expression", () => {
    it("named", () => {
      const expr = parseExpr("(function foo(a) { return a })");
      expect(expr).toMatchObject({
        type: NodeType.FunctionExpression,
        name: "foo",
      });
    });

    it("anonymous", () => {
      const expr = parseExpr("(function(x) { return x })");
      expect(expr.name).toBe(null);
    });
  });

  describe("template literal", () => {
    it("simple", () => {
      const expr = parseExpr("`hello`");
      expect(expr.type).toBe(NodeType.TemplateLiteral);
      expect(expr.parts).toEqual(["hello"]);
    });

    it("with expressions", () => {
      const expr = parseExpr("`a${1 + 2}b`");
      expect(expr.parts).toEqual(["a", "b"]);
      expect(expr.expressions).toHaveLength(1);
      expect(expr.expressions[0].type).toBe(NodeType.BinaryExpression);
    });
  });

  describe("declarations", () => {
    it("let/const/var declaration types", () => {
      const cases = [
        ["let x = 1", NodeType.LetDeclaration],
        ["const y = 2", NodeType.ConstDeclaration],
        ["var z = 3", NodeType.VarDeclaration],
      ];
      for (const [src, expectedType] of cases) {
        expect(parseStmt(src).type).toBe(expectedType);
      }
    });

    it("let without init", () => {
      const stmt = parseStmt("let x");
      expect(stmt.init).toBe(null);
    });

    it("const without init throws", () => {
      expect(() => parse("const x")).toThrow(/Missing initializer/);
    });

    it("multiple declarations", () => {
      const ast = parse("let a = 1, b = 2");
      expect(ast.body).toHaveLength(2);
      expect(ast.body[0].name).toBe("a");
      expect(ast.body[1].name).toBe("b");
    });

    it("object destructuring", () => {
      const stmt = parseStmt("const { a, b } = obj");
      expect(stmt.type).toBe(NodeType.ObjectDestructuring);
    });

    it("object destructuring with alias", () => {
      const stmt = parseStmt("const { a: x } = obj");
      expect(stmt.pattern.props[0]).toMatchObject({
        key: "a",
        value: { kind: "id", name: "x" },
      });
    });

    it("array destructuring", () => {
      const stmt = parseStmt("const [a, b] = arr");
      expect(stmt.type).toBe(NodeType.ArrayDestructuring);
      expect(stmt.pattern.elements).toEqual([
        { kind: "id", name: "a" },
        { kind: "id", name: "b" },
      ]);
    });

    it("array destructuring with holes", () => {
      const stmt = parseStmt("const [a, , b] = arr");
      expect(stmt.pattern.elements).toEqual([
        { kind: "id", name: "a" },
        null,
        { kind: "id", name: "b" },
      ]);
    });

    it("array destructuring with rest and defaults", () => {
      const stmt = parseStmt("const [a = 1, ...rest] = arr");
      expect(stmt.pattern.elements[0]).toMatchObject({ kind: "id", name: "a" });
      expect(stmt.pattern.elements[0].default).toBeTruthy();
      expect(stmt.pattern.rest).toMatchObject({ kind: "id", name: "rest" });
    });

    it("nested object destructuring", () => {
      const stmt = parseStmt("const { a: { b } } = obj");
      expect(stmt.pattern.props[0].value).toMatchObject({ kind: "object" });
    });
  });

  describe("function declaration", () => {
    it("basic function", () => {
      const stmt = parseStmt("function foo(a, b) { return a + b }");
      expect(stmt).toMatchObject({
        type: NodeType.FunctionDeclaration,
        name: "foo",
        async: false,
      });
      expect(stmt.params).toEqual(["a", "b"]);
    });

    it("async function", () => {
      const stmt = parseStmt("async function bar() { await x }");
      expect(stmt).toMatchObject({
        type: NodeType.FunctionDeclaration,
        name: "bar",
        async: true,
      });
    });

    it("generator function", () => {
      const stmt = parseStmt("function* gen() { yield 1 }");
      expect(stmt).toMatchObject({
        type: NodeType.FunctionDeclaration,
        generator: true,
      });
    });

    it("default parameters", () => {
      const stmt = parseStmt("function f(a, b = 1) {}");
      expect(stmt.params[0]).toBe("a");
      expect(stmt.params[1]).toHaveProperty("default");
    });

    it("rest parameters", () => {
      const stmt = parseStmt("function f(...args) {}");
      expect(stmt.params[0]).toMatchObject({ name: "args", rest: true });
    });
  });

  describe("if statement", () => {
    it("if only", () => {
      const stmt = parseStmt("if (x) { y }");
      expect(stmt).toMatchObject({
        type: NodeType.IfStatement,
        test: { name: "x" },
        alternate: null,
      });
    });

    it("if else", () => {
      const stmt = parseStmt("if (x) { a } else { b }");
      expect(stmt.alternate).not.toBe(null);
    });

    it("if else if", () => {
      const stmt = parseStmt("if (a) { x } else if (b) { y } else { z }");
      expect(stmt.alternate.type).toBe(NodeType.IfStatement);
    });

    it("without braces", () => {
      const stmt = parseStmt("if (x) y");
      expect(stmt.type).toBe(NodeType.IfStatement);
    });
  });

  describe("while statement", () => {
    it("basic while", () => {
      const stmt = parseStmt("while (x) { y }");
      expect(stmt).toMatchObject({
        type: NodeType.WhileStatement,
        test: { name: "x" },
      });
    });

    it("without braces", () => {
      const stmt = parseStmt("while (true) x");
      expect(stmt.type).toBe(NodeType.WhileStatement);
    });
  });

  describe("do while statement", () => {
    it("basic do while", () => {
      const stmt = parseStmt("do { x } while (y)");
      expect(stmt).toMatchObject({
        type: NodeType.DoWhileStatement,
        test: { name: "y" },
      });
    });
  });

  describe("for statement", () => {
    it("basic for", () => {
      const stmt = parseStmt("for (let i = 0; i < 10; i++) { x }");
      expect(stmt.type).toBe(NodeType.ForStatement);
      expect(stmt.init.type).toBe(NodeType.LetDeclaration);
    });

    it("for in", () => {
      const stmt = parseStmt("for (let k in obj) { x }");
      expect(stmt.type).toBe(NodeType.ForInStatement);
      expect(stmt.variable).toBe("k");
    });

    it("for of", () => {
      const stmt = parseStmt("for (let v of arr) { x }");
      expect(stmt.type).toBe(NodeType.ForOfStatement);
      expect(stmt.variable).toBe("v");
    });

    it("for with empty parts", () => {
      const stmt = parseStmt("for (;;) { x }");
      expect(stmt.init).toBe(null);
      expect(stmt.test).toBe(null);
      expect(stmt.update).toBe(null);
    });
  });

  describe("return statement", () => {
    it("return with value", () => {
      const ast = parse("function f() { return 42 }");
      const ret = ast.body[0].body.body[0];
      expect(ret).toMatchObject({
        type: NodeType.ReturnStatement,
        argument: { value: 42 },
      });
    });

    it("return without value", () => {
      const ast = parse("function f() { return }");
      const ret = ast.body[0].body.body[0];
      expect(ret.argument).toBe(null);
    });
  });

  describe("switch statement", () => {
    it("switch with cases", () => {
      const stmt = parseStmt(
        "switch (x) { case 1: y; break; default: z; }",
      );
      expect(stmt.type).toBe(NodeType.SwitchStatement);
      expect(stmt.cases).toHaveLength(2);
      expect(stmt.cases[0].test.value).toBe(1);
      expect(stmt.cases[1].test).toBe(null);
    });
  });

  describe("break and continue", () => {
    it("break", () => {
      const ast = parse("while (true) { break }");
      const brk = ast.body[0].body.body[0];
      expect(brk.type).toBe(NodeType.BreakStatement);
    });

    it("continue", () => {
      const ast = parse("while (true) { continue }");
      const cnt = ast.body[0].body.body[0];
      expect(cnt.type).toBe(NodeType.ContinueStatement);
    });

    it("break with label", () => {
      const ast = parse("outer: while (true) { break outer }");
      const loop = ast.body[0].body;
      const brk = loop.body.body[0];
      expect(brk.label).toBe("outer");
    });
  });

  describe("try catch finally", () => {
    it("try catch", () => {
      const stmt = parseStmt("try { x } catch (e) { y }");
      expect(stmt.type).toBe(NodeType.TryStatement);
      expect(stmt.handler.param).toBe("e");
      expect(stmt.finalizer).toBe(null);
    });

    it("try finally", () => {
      const stmt = parseStmt("try { x } finally { y }");
      expect(stmt.handler).toBe(null);
      expect(stmt.finalizer).not.toBe(null);
    });

    it("try catch finally", () => {
      const stmt = parseStmt("try { x } catch (e) { y } finally { z }");
      expect(stmt.handler).not.toBe(null);
      expect(stmt.finalizer).not.toBe(null);
    });

    it("catch without param", () => {
      const stmt = parseStmt("try { x } catch { y }");
      expect(stmt.handler.param).toBe(null);
    });

    it("try without catch or finally throws", () => {
      expect(() => parse("try { x }")).toThrow(/Missing catch or finally/);
    });
  });

  describe("throw statement", () => {
    it("throw", () => {
      const stmt = parseStmt("throw new Error('x')");
      expect(stmt.type).toBe(NodeType.ThrowStatement);
      expect(stmt.argument.type).toBe(NodeType.NewExpression);
    });
  });

  describe("class declaration", () => {
    it("basic class", () => {
      const stmt = parseStmt("class Foo { constructor() {} bar() {} }");
      expect(stmt).toMatchObject({
        type: NodeType.ClassDeclaration,
        name: "Foo",
        superClass: null,
      });
      expect(stmt.constructor).not.toBe(null);
      expect(stmt.methods).toHaveLength(1);
    });

    it("extends", () => {
      const stmt = parseStmt("class Bar extends Foo { constructor() {} }");
      expect(stmt.superClass).toMatchObject({
        type: NodeType.Identifier,
        name: "Foo",
      });
    });

    it("getter and setter", () => {
      const stmt = parseStmt(
        "class C { get x() { return 1 } set x(v) { } }",
      );
      expect(stmt.methods[0].kind).toBe("get");
      expect(stmt.methods[1].kind).toBe("set");
    });
  });

  describe("labeled statement", () => {
    it("label", () => {
      const stmt = parseStmt("loop: while (true) { break loop }");
      expect(stmt.type).toBe(NodeType.LabeledStatement);
      expect(stmt.label).toBe("loop");
    });
  });

  describe("yield expression", () => {
    it("yield", () => {
      const ast = parse("function* g() { yield 1 }");
      const yld = ast.body[0].body.body[0].expression;
      expect(yld).toMatchObject({
        type: NodeType.YieldExpression,
        delegate: false,
      });
    });

    it("yield delegate", () => {
      const ast = parse("function* g() { yield* other() }");
      const yld = ast.body[0].body.body[0].expression;
      expect(yld.delegate).toBe(true);
    });
  });

  describe("await expression", () => {
    it("await", () => {
      const ast = parse("async function f() { await promise }");
      const awaitExpr = ast.body[0].body.body[0].expression;
      expect(awaitExpr.type).toBe(NodeType.AwaitExpression);
    });
  });

  describe("super call", () => {
    it("super()", () => {
      const ast = parse(
        "class B extends A { constructor() { super(1) } }",
      );
      const superCall = ast.body[0].constructor.body.body[0].expression;
      expect(superCall.type).toBe(NodeType.SuperCallExpression);
      expect(superCall.args).toHaveLength(1);
    });
  });

  describe("regex literal", () => {
    it("regex in expression", () => {
      const ast = parse("let r = /abc/gi");
      expect(ast.body[0].init).toMatchObject({
        type: NodeType.Literal,
        kind: "regex",
      });
      expect(ast.body[0].init.value.pattern).toBe("abc");
      expect(ast.body[0].init.value.flags).toBe("gi");
    });
  });

  describe("complex programs", () => {
    it("fibonacci", () => {
      const ast = parse(`
        function fib(n) {
          if (n <= 1) return n
          return fib(n - 1) + fib(n - 2)
        }
      `);
      expect(ast.body[0].type).toBe(NodeType.FunctionDeclaration);
      expect(ast.body[0].name).toBe("fib");
    });

    it("class with methods", () => {
      const ast = parse(`
        class Counter extends Base {
          constructor(start) {
            super(start)
          }
          increment() {
            this.count++
          }
        }
      `);
      expect(ast.body[0].type).toBe(NodeType.ClassDeclaration);
    });

    it("array methods chain", () => {
      const ast = parse("arr.map(x => x * 2).filter(x => x > 5)");
      expect(ast.body[0].expression.type).toBe(NodeType.CallExpression);
    });

    it("nested ternary", () => {
      const expr = parseExpr("a ? b ? c : d : e");
      expect(expr.type).toBe(NodeType.ConditionalExpression);
      expect(expr.consequent.type).toBe(NodeType.ConditionalExpression);
    });

    it("for of with destructuring body", () => {
      const ast = parse(`
        for (let item of items) {
          const { a, b } = item
        }
      `);
      expect(ast.body[0].type).toBe(NodeType.ForOfStatement);
    });
  });

  describe("error handling", () => {
    it("unexpected token", () => {
      expect(() => parse("let = 1")).toThrow();
    });

    it("missing closing paren", () => {
      expect(() => parse("foo(1, 2")).toThrow();
    });

    it("missing closing brace", () => {
      expect(() => parse("{ let x = 1")).toThrow();
    });

    it("invalid assignment target", () => {
      expect(() => parse("1 = 2")).toThrow(/Invalid assignment/);
    });
  });
});
