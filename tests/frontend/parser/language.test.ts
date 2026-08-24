import { describe, it, expect } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { NodeType } from "../../../src/frontend/ast/index.js";

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

    it("word logical operators normalize to logical nodes", () => {
      for (const [src, op] of [["a and b", "&&"], ["a or b", "||"]]) {
        const expr = parseExpr(src);
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
        ["-x", "-"], ["+x", "+"], ["!x", "!"], ["not x", "!"], ["~x", "~"],
        ["typeof x", "typeof"], ["delete obj.x", "delete"],
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

    it("rejects method shorthand with a brace body (blocks are offside-only)", () => {
      expect(() => parse("x = { foo(a) { return a } }")).toThrow();
    });

    it("rejects object getter/setter with a brace body", () => {
      expect(() => parse("x = { get a() { return 1 }, set a(v) { } }")).toThrow();
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

    it("rejects a brace block body (arrows take an expression body)", () => {
      expect(() => parse("f = (x) => { return x }")).toThrow();
    });

    it("default params", () => {
      const expr = parseExpr("(a, b = 1) => a + b");
      expect(expr.params[0]).toBe("a");
      expect(expr.params[1]).toMatchObject({
        name: "b",
        default: { type: NodeType.Literal, kind: "number", value: 1 },
      });
    });

    it("rest params", () => {
      const expr = parseExpr("(...args) => args");
      expect(expr.params[0]).toMatchObject({ name: "args", rest: true });
    });
  });

  describe("function expression", () => {
    it("rejects a named function expression with a brace body", () => {
      expect(() => parse("g = (function foo(a) { return a })")).toThrow();
    });

    it("rejects an anonymous function expression with a brace body", () => {
      expect(() => parse("g = (function(x) { return x })")).toThrow();
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
    it("annotated declaration", () => {
      const stmt = parseStmt("x: int = 1");
      expect(stmt).toMatchObject({ type: NodeType.LetDeclaration, name: "x", declaredType: "int" });
    });

    it("object destructuring", () => {
      const stmt = parseStmt("{ a, b } = obj");
      expect(stmt.type).toBe(NodeType.ObjectDestructuring);
    });

    it("object destructuring with alias", () => {
      const stmt = parseStmt("{ a: x } = obj");
      expect(stmt.pattern.props[0]).toMatchObject({
        key: "a",
        value: { kind: "id", name: "x" },
      });
    });

    it("array destructuring", () => {
      const stmt = parseStmt("[a, b] = arr");
      expect(stmt.type).toBe(NodeType.ArrayDestructuring);
      expect(stmt.pattern.elements).toEqual([
        { kind: "id", name: "a" },
        { kind: "id", name: "b" },
      ]);
    });

    it("array destructuring with holes", () => {
      const stmt = parseStmt("[a, , b] = arr");
      expect(stmt.pattern.elements).toEqual([
        { kind: "id", name: "a" },
        null,
        { kind: "id", name: "b" },
      ]);
    });

    it("array destructuring with rest and defaults", () => {
      const stmt = parseStmt("[a = 1, ...rest] = arr");
      expect(stmt.pattern.elements[0]).toMatchObject({
        kind: "id",
        name: "a",
        default: { type: NodeType.Literal, kind: "number", value: 1 },
      });
      expect(stmt.pattern.rest).toMatchObject({ kind: "id", name: "rest" });
    });

    it("nested object destructuring", () => {
      const stmt = parseStmt("{ a: { b } } = obj");
      expect(stmt.pattern.props[0].value).toMatchObject({ kind: "object" });
    });
  });

  describe("reserved declaration keywords", () => {
    const rejected = /is not a tera keyword; declare a variable as 'name: type = value'/;

    for (const keyword of ["let", "const", "var"]) {
      it(`rejects '${keyword}' at statement position`, () => {
        expect(() => parse(`${keyword} x = 1`)).toThrow(rejected);
      });

      it(`rejects '${keyword}' inside a function body`, () => {
        expect(() => parse(`fn f():\n  ${keyword} y = 2\n  return y`)).toThrow(rejected);
      });

      it(`rejects '${keyword}' in a for initializer`, () => {
        expect(() => parse(`for (${keyword} i = 0; i < 3; i = i + 1):\n  print(i)`)).toThrow(rejected);
      });

      it(`rejects '${keyword}' in expression position`, () => {
        expect(() => parse(`x = ${keyword}`)).toThrow(rejected);
      });

      it(`reports where '${keyword}' appears`, () => {
        expect(() => parse(`x = 1\n${keyword} y = 2`)).toThrow(/at 2:1/);
      });
    }

    it("leaves an identifier that merely starts with a reserved word alone", () => {
      expect(parseStmt("lets: int = 4")).toMatchObject({
        type: NodeType.LetDeclaration,
        name: "lets",
      });
    });
  });

  describe("function declaration", () => {
    it("basic function", () => {
      const stmt = parseStmt("fn foo(a, b):\n  return a + b");
      expect(stmt).toMatchObject({
        type: NodeType.FunctionDeclaration,
        name: "foo",
        async: false,
      });
      expect(stmt.params).toEqual(["a", "b"]);
    });

    it("async function", () => {
      const stmt = parseStmt("async fn bar():\n  await x");
      expect(stmt).toMatchObject({
        type: NodeType.FunctionDeclaration,
        name: "bar",
        async: true,
      });
    });

    it("generator function", () => {
      const stmt = parseStmt("fn* gen():\n  yield 1");
      expect(stmt).toMatchObject({
        type: NodeType.FunctionDeclaration,
        generator: true,
      });
    });

    it("default parameters", () => {
      const stmt = parseStmt("fn f(a, b = 1):\n  return a");
      expect(stmt.params[0]).toBe("a");
      expect(stmt.params[1]).toMatchObject({
        name: "b",
        default: { type: NodeType.Literal, kind: "number", value: 1 },
      });
    });

    it("rest parameters", () => {
      const stmt = parseStmt("fn f(...args):\n  return args");
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
      const stmt = parseStmt("if x:\n  a\nelse:\n  b");
      expect(stmt.alternate).not.toBe(null);
    });

    it("if else if", () => {
      const stmt = parseStmt("if a:\n  x\nelse if b:\n  y\nelse:\n  z");
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

  describe("parenthesised control conditions", () => {
    const condition = (src) => parseStmt(src).test;
    const tree = (src) => JSON.stringify(condition(src));

    it("group on the left of and becomes the left operand", () => {
      expect(condition("if (c >= 48) and c <= 57:\n  x")).toMatchObject({
        type: NodeType.LogicalExpression,
        op: "&&",
        left: { type: NodeType.BinaryExpression, op: ">=" },
        right: { type: NodeType.BinaryExpression, op: "<=" },
      });
    });

    it("group on the left of or becomes the left operand", () => {
      expect(condition("if (c >= 48 and c <= 57) or c == 45:\n  x")).toMatchObject({
        type: NodeType.LogicalExpression,
        op: "||",
        left: { type: NodeType.LogicalExpression, op: "&&" },
        right: { type: NodeType.BinaryExpression, op: "==" },
      });
    });

    it("groups on both sides of or", () => {
      expect(condition("if (c >= 48 and c <= 57) or (c == 45 and signed):\n  x")).toMatchObject({
        type: NodeType.LogicalExpression,
        op: "||",
        left: { type: NodeType.LogicalExpression, op: "&&", left: { op: ">=" } },
        right: { type: NodeType.LogicalExpression, op: "&&", left: { op: "==" } },
      });
    });

    it("nested groups on the left", () => {
      expect(condition("if ((a or b) and (c or d)) or e:\n  x")).toMatchObject({
        type: NodeType.LogicalExpression,
        op: "||",
        left: {
          type: NodeType.LogicalExpression,
          op: "&&",
          left: { type: NodeType.LogicalExpression, op: "||", left: { name: "a" } },
          right: { type: NodeType.LogicalExpression, op: "||", left: { name: "c" } },
        },
        right: { name: "e" },
      });
    });

    it("a leading group parses the same as the bare and the fully wrapped spellings", () => {
      const spellings = [
        "if (c >= 48 and c <= 57) or c == 45:\n  x",
        "if c >= 48 and c <= 57 or c == 45:\n  x",
        "if ((c >= 48 and c <= 57) or c == 45):\n  x",
      ];
      for (const src of spellings) expect(tree(src)).toBe(tree(spellings[0]));
    });

    it("a leading group continues into any infix operator, not just and/or", () => {
      expect(condition("if (c + 1) > 2:\n  x")).toMatchObject({
        type: NodeType.BinaryExpression,
        op: ">",
        left: { type: NodeType.BinaryExpression, op: "+" },
      });
      expect(condition("if (a).b and c:\n  x")).toMatchObject({
        type: NodeType.LogicalExpression,
        op: "&&",
        left: { type: NodeType.MemberExpression, property: "b" },
      });
    });

    it("while and switch take a leading group the same way", () => {
      expect(condition("while (c > 0) and c < 100:\n  x")).toMatchObject({
        type: NodeType.LogicalExpression,
        op: "&&",
      });
      expect(parseStmt("switch (a) or b:\n  default:\n    x").discriminant).toMatchObject({
        type: NodeType.LogicalExpression,
        op: "||",
      });
    });

    it("a group condition still ends before a braceless body", () => {
      for (const src of ["if (x) y", "if (x) { y }", "if (x) (y)(z)", "if (x) [y].len()"]) {
        expect(parseStmt(src)).toMatchObject({
          type: NodeType.IfStatement,
          test: { type: NodeType.Identifier, name: "x" },
        });
      }
    });

    it("a parenthesised condition may be a sequence", () => {
      expect(condition("if (a, b > 1):\n  x")).toMatchObject({
        type: NodeType.SequenceExpression,
      });
    });
  });

  describe("do while statement", () => {
    it("basic do while", () => {
      const stmt = parseStmt("do:\n  x\nwhile (y)");
      expect(stmt).toMatchObject({
        type: NodeType.DoWhileStatement,
        test: { name: "y" },
      });
    });
  });

  describe("for statement", () => {
    it("basic for", () => {
      const stmt = parseStmt("for (i = 0; i < 10; i++) { x }");
      expect(stmt.type).toBe(NodeType.ForStatement);
      expect(stmt.init.type).toBe(NodeType.ExpressionStatement);
    });

    it("for in", () => {
      const stmt = parseStmt("for k in obj:\n  x");
      expect(stmt.type).toBe(NodeType.ForInStatement);
      expect(stmt.variable).toMatchObject({ kind: "id", name: "k" });
    });

    it("for of", () => {
      const stmt = parseStmt("for v of arr:\n  x");
      expect(stmt.type).toBe(NodeType.ForOfStatement);
      expect(stmt.variable).toMatchObject({ kind: "id", name: "v" });
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
      const ast = parse("fn f():\n  return 42");
      const ret = ast.body[0].body.body[0];
      expect(ret).toMatchObject({
        type: NodeType.ReturnStatement,
        argument: { value: 42 },
      });
    });

    it("return without value", () => {
      const ast = parse("fn f():\n  return");
      const ret = ast.body[0].body.body[0];
      expect(ret.argument).toBe(null);
    });
  });

  describe("switch statement", () => {
    it("switch with cases", () => {
      const stmt = parseStmt(
        "switch x:\n  case 1:\n    y\n    break\n  default:\n    z",
      );
      expect(stmt.type).toBe(NodeType.SwitchStatement);
      expect(stmt.cases).toHaveLength(2);
      expect(stmt.cases[0].test.value).toBe(1);
      expect(stmt.cases[1].test).toBe(null);
    });
  });

  describe("break and continue", () => {
    it("break", () => {
      const ast = parse("while true:\n  break");
      const brk = ast.body[0].body.body[0];
      expect(brk.type).toBe(NodeType.BreakStatement);
    });

    it("continue", () => {
      const ast = parse("while true:\n  continue");
      const cnt = ast.body[0].body.body[0];
      expect(cnt.type).toBe(NodeType.ContinueStatement);
    });

    it("break with label", () => {
      const ast = parse("outer: while true:\n  break outer");
      const loop = ast.body[0].body;
      const brk = loop.body.body[0];
      expect(brk.label).toBe("outer");
    });
  });

  describe("try catch finally", () => {
    it("try catch", () => {
      const stmt = parseStmt("try:\n  x\ncatch e:\n  y");
      expect(stmt.type).toBe(NodeType.TryStatement);
      expect(stmt.handler.param).toBe("e");
      expect(stmt.finalizer).toBe(null);
    });

    it("try finally", () => {
      const stmt = parseStmt("try:\n  x\nfinally:\n  y");
      expect(stmt.handler).toBe(null);
      expect(stmt.finalizer).not.toBe(null);
    });

    it("try catch finally", () => {
      const stmt = parseStmt("try:\n  x\ncatch e:\n  y\nfinally:\n  z");
      expect(stmt.handler).not.toBe(null);
      expect(stmt.finalizer).not.toBe(null);
    });

    it("catch without param", () => {
      const stmt = parseStmt("try:\n  x\ncatch:\n  y");
      expect(stmt.handler.param).toBe(null);
    });

    it("try without catch or finally throws", () => {
      expect(() => parse("try:\n  x")).toThrow(/Missing catch or finally/);
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
      const stmt = parseStmt("class Foo:\n  constructor():\n    this.x = 1\n  bar():\n    return 1");
      expect(stmt).toMatchObject({
        type: NodeType.ClassDeclaration,
        name: "Foo",
        superClass: null,
      });
      expect(stmt.constructor).not.toBe(null);
      expect(stmt.methods).toHaveLength(1);
    });

    it("extends", () => {
      const stmt = parseStmt("class Bar extends Foo:\n  constructor():\n    this.x = 1");
      expect(stmt.superClass).toMatchObject({
        type: NodeType.Identifier,
        name: "Foo",
      });
    });

    it("getter and setter", () => {
      const stmt = parseStmt(
        "class C:\n  get x():\n    return 1\n  set x(v):\n    this.v = v",
      );
      expect(stmt.methods[0].kind).toBe("get");
      expect(stmt.methods[1].kind).toBe("set");
    });

    it("parses visibility modifiers and class fields", () => {
      const stmt = parseStmt([
        "class Account:",
        "  private balance: float = 0.0",
        "  static protected instances: int = 0",
        "  private static token",
        "  public constructor(owner: string):",
        "    this.owner = owner",
        "  private get hidden() -> int:",
        "    return 1",
        "  protected set hidden(value: int):",
        "    this.value = value",
      ].join("\n"));

      expect(stmt.fields).toEqual([
        expect.objectContaining({ name: "balance", static: false, visibility: "private", explicitVisibility: true, init: expect.objectContaining({ kind: "number" }) }),
        expect.objectContaining({ name: "instances", static: true, visibility: "protected", explicitVisibility: true, init: expect.objectContaining({ kind: "number" }) }),
        expect.objectContaining({ name: "token", static: true, visibility: "private", explicitVisibility: true, init: null }),
      ]);
      expect(stmt.constructor).toMatchObject({ name: "constructor", visibility: "public" });
      expect(stmt.methods.find((method) => method.kind === "get" && method.name === "hidden")).toMatchObject({ visibility: "private", static: false });
      expect(stmt.methods.find((method) => method.kind === "set" && method.name === "hidden")).toMatchObject({ visibility: "protected", static: false });
    });

    it("marks fields declared without a visibility keyword as not explicit", () => {
      const stmt = parseStmt([
        "class Report:",
        "  title: string",
        "  public sections: string[]",
      ].join("\n"));

      expect(stmt.fields).toEqual([
        expect.objectContaining({ name: "title", explicitVisibility: false }),
        expect.objectContaining({ name: "sections", visibility: "public", explicitVisibility: true }),
      ]);
    });

    it("rejects duplicate and conflicting class member modifiers", () => {
      expect(() => parse("class C:\n  private public value")).toThrow(/Conflicting class member visibility/);
      expect(() => parse("class C:\n  private private value")).toThrow(/Conflicting class member visibility/);
      expect(() => parse("class C:\n  static static value")).toThrow(/Duplicate class member modifier 'static'/);
    });

    it("parses abstract classes and abstract member signatures", () => {
      const stmt = parseStmt([
        "abstract class Shape:",
        "  protected abstract area() -> float",
        "  abstract label() -> string",
      ].join("\n"));
      expect(stmt.abstract).toBe(true);
      expect(stmt.methods).toEqual([
        expect.objectContaining({ name: "area", visibility: "protected", abstract: true }),
        expect.objectContaining({ name: "label", visibility: "public", abstract: true }),
      ]);
      expect(stmt.methods[0].func.body.body).toEqual([]);
    });

    it("rejects invalid abstract class members", () => {
      expect(() => parse("abstract class C:\n  abstract value")).toThrow(/Abstract class fields are not supported/);
      expect(() => parse("abstract class C:\n  abstract constructor()")).toThrow(/Constructors cannot be abstract/);
      expect(() => parse("abstract class C:\n  static abstract value()")).toThrow(/Static class members cannot be abstract/);
      expect(() => parse("abstract class C:\n  abstract value() -> int:\n    return 1")).toThrow(/Abstract class members cannot have a body/);
    });
  });

  describe("labeled statement", () => {
    it("label", () => {
      const stmt = parseStmt("loop: while true:\n  break loop");
      expect(stmt.type).toBe(NodeType.LabeledStatement);
      expect(stmt.label).toBe("loop");
    });
  });

  describe("yield expression", () => {
    it("yield", () => {
      const ast = parse("fn* g():\n  yield 1");
      const yld = ast.body[0].body.body[0].expression;
      expect(yld).toMatchObject({
        type: NodeType.YieldExpression,
        delegate: false,
      });
    });

    it("yield delegate", () => {
      const ast = parse("fn* g():\n  yield* other()");
      const yld = ast.body[0].body.body[0].expression;
      expect(yld.delegate).toBe(true);
    });
  });

  describe("await expression", () => {
    it("await", () => {
      const ast = parse("async fn f():\n  await promise");
      const awaitExpr = ast.body[0].body.body[0].expression;
      expect(awaitExpr.type).toBe(NodeType.AwaitExpression);
    });
  });

  describe("super call", () => {
    it("super()", () => {
      const ast = parse(
        "class B extends A:\n  constructor():\n    super(1)",
      );
      const superCall = ast.body[0].constructor.body.body[0].expression;
      expect(superCall.type).toBe(NodeType.SuperCallExpression);
      expect(superCall.args).toHaveLength(1);
    });
  });

  describe("regex literal", () => {
    it("regex in expression", () => {
      const ast = parse("r: regex = /abc/gi");
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
      const ast = parse(
        "fn fib(n):\n  if n <= 1:\n    return n\n  return fib(n - 1) + fib(n - 2)",
      );
      expect(ast.body[0].type).toBe(NodeType.FunctionDeclaration);
      expect(ast.body[0].name).toBe("fib");
    });

    it("class with methods", () => {
      const ast = parse(
        "class Counter extends Base:\n  constructor(start):\n    super(start)\n  increment():\n    this.count = this.count + 1",
      );
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
      const ast = parse(
        "for item of items:\n  { a, b } = item",
      );
      expect(ast.body[0].type).toBe(NodeType.ForOfStatement);
    });
  });

  describe("error handling", () => {
    it("unexpected token", () => {
      expect(() => parse("= 1")).toThrow();
    });

    it("missing closing paren", () => {
      expect(() => parse("foo(1, 2")).toThrow();
    });

    it("missing closing brace", () => {
      expect(() => parse("{ x: 1")).toThrow();
    });

    it("invalid assignment target", () => {
      expect(() => parse("1 = 2")).toThrow(/Invalid assignment/);
    });
  });

  describe("index access", () => {
    it("lowers a single index to a computed member expression", () => {
      const expr = parseExpr("a[0]");
      expect(expr.type).toBe(NodeType.MemberExpression);
      expect(expr.computed).toBe(true);
      expect(expr.property.type).toBe(NodeType.Literal);
      expect(expr.property.value).toBe(0);
    });

    it("keeps a negative and a dynamic single index on the member path", () => {
      expect(parseExpr("a[-1]").type).toBe(NodeType.MemberExpression);
      expect(parseExpr("a[i]").type).toBe(NodeType.MemberExpression);
      expect(parseExpr("a[f(1)]").type).toBe(NodeType.MemberExpression);
    });

    it("lowers a slice to an index expression with one slice dimension", () => {
      const expr = parseExpr("a[1:3]");
      expect(expr.type).toBe(NodeType.IndexExpression);
      expect(expr.dims).toHaveLength(1);
      expect(expr.dims[0].type).toBe(NodeType.IndexElement);
      expect(expr.dims[0].kind).toBe("slice");
      expect(expr.dims[0].start.value).toBe(1);
      expect(expr.dims[0].stop.value).toBe(3);
      expect(expr.dims[0].step).toBeNull();
    });

    it("records absent slice bounds as null", () => {
      const open = parseExpr("a[:]").dims[0];
      expect(open.start).toBeNull();
      expect(open.stop).toBeNull();
      expect(open.step).toBeNull();

      const stepped = parseExpr("a[::2]").dims[0];
      expect(stepped.start).toBeNull();
      expect(stepped.stop).toBeNull();
      expect(stepped.step.value).toBe(2);
    });

    it("lowers a multi-dimensional index to one dimension per subscript", () => {
      const expr = parseExpr("a[i, j]");
      expect(expr.type).toBe(NodeType.IndexExpression);
      expect(expr.dims).toHaveLength(2);
      expect(expr.dims.map((d) => d.kind)).toEqual(["index", "index"]);
      expect(expr.dims[0].value.name).toBe("i");
      expect(expr.dims[1].value.name).toBe("j");
    });

    it("mixes index and slice dimensions in order", () => {
      const expr = parseExpr("a[1, 1:3]");
      expect(expr.dims.map((d) => d.kind)).toEqual(["index", "slice"]);
      expect(expr.dims[0].value.value).toBe(1);
      expect(expr.dims[1].start.value).toBe(1);
      expect(expr.dims[1].stop.value).toBe(3);
    });

    it("keeps the object on the index expression", () => {
      const expr = parseExpr("matrix[:, 0]");
      expect(expr.object.type).toBe(NodeType.Identifier);
      expect(expr.object.name).toBe("matrix");
      expect(expr.dims.map((d) => d.kind)).toEqual(["slice", "index"]);
    });

    it("chains an index expression with a following call", () => {
      const expr = parseExpr("a[0:2].to_array()");
      expect(expr.type).toBe(NodeType.CallExpression);
      expect(expr.callee.type).toBe(NodeType.MemberExpression);
      expect(expr.callee.object.type).toBe(NodeType.IndexExpression);
    });

    it("rejects assignment to a slice", () => {
      expect(() => parse("a[0:2] = [1, 2]")).toThrow(/Invalid assignment/);
    });
  });

  describe("generic call disambiguation", () => {
    it("parses a comparison chain that ends in a parenthesised operand", () => {
      const expr = parseExpr("(a < b) > (c)");
      expect(expr.type).toBe(NodeType.BinaryExpression);
      expect(expr.op).toBe(">");
      expect(expr.left.type).toBe(NodeType.BinaryExpression);
      expect(expr.left.op).toBe("<");
    });

    it("parses a conditional whose branch compares parenthesised operands", () => {
      const expr = parseExpr("((i < 9) ? ((i) > (acc)) : 1)");
      expect(expr.type).toBe(NodeType.ConditionalExpression);
      expect(expr.consequent.type).toBe(NodeType.BinaryExpression);
      expect(expr.consequent.op).toBe(">");
    });

    it("still treats an identifier followed by type arguments as a call", () => {
      const expr = parseExpr("f<T>(x)");
      expect(expr.type).toBe(NodeType.CallExpression);
      expect(expr.callee.type).toBe(NodeType.Identifier);
      expect(expr.callee.name).toBe("f");
      expect(expr.callee.typeArgs).toEqual(["T"]);
    });

    it("still treats a multi-argument type list as a call", () => {
      const expr = parseExpr("f<A, B>(x)");
      expect(expr.type).toBe(NodeType.CallExpression);
      expect(expr.callee.name).toBe("f");
      expect(expr.callee.typeArgs).toEqual(["A", "B"]);
    });
  });

  describe("type annotations", () => {
    it("skips generic type arguments containing commas", () => {
      const stmt = parseStmt("counts: Map<string, int> = m");
      expect(stmt).toMatchObject({ type: NodeType.LetDeclaration, name: "counts" });
      expect(stmt.init.type).toBe(NodeType.Identifier);
    });

    it("skips nested generic type arguments", () => {
      const stmt = parseStmt("m: Map<string, Array<int>> = source");
      expect(stmt).toMatchObject({ type: NodeType.LetDeclaration, name: "m" });
      expect(stmt.init.type).toBe(NodeType.Identifier);
    });

    it("skips an object type in return position", () => {
      const stmt = parseStmt("fn f() -> { id: int, name: string }:\n  return x");
      expect(stmt).toMatchObject({ type: NodeType.FunctionDeclaration, name: "f" });
      expect(stmt.body.body).toHaveLength(1);
    });

    it("skips a function type in return position", () => {
      const stmt = parseStmt("fn f() -> (int) -> bool:\n  return g");
      expect(stmt).toMatchObject({ type: NodeType.FunctionDeclaration, name: "f" });
    });

    it("skips a fn-prefixed function type in return position", () => {
      const stmt = parseStmt("fn adder(base: int) -> fn(int) -> int:\n  return add");
      expect(stmt).toMatchObject({ type: NodeType.FunctionDeclaration, name: "adder" });
    });

    it("accepts a return type annotation on a class getter", () => {
      const stmt = parseStmt("class C:\n  get value() -> int:\n    return 1");
      const accessor = stmt.methods.find((m) => m.name === "value");
      expect(accessor).toMatchObject({ kind: "get" });
    });

    it("accepts a typed parameter on a class setter", () => {
      const stmt = parseStmt("class C:\n  set value(v: int):\n    return");
      const accessor = stmt.methods.find((m) => m.name === "value");
      expect(accessor).toMatchObject({ kind: "set" });
      expect(accessor.func.params).toEqual(["v"]);
    });
  });
});
