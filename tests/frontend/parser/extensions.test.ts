import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { NodeType, type ASTNode } from "../../../src/frontend/ast/index.js";
import type { SyntaxPlugin } from "../../../src/frontend/parser/extensions.js";

function identifier(name: string): ASTNode {
  return { type: NodeType.Identifier, name };
}

function literal(value: number): ASTNode {
  return { type: NodeType.Literal, value, kind: "number" };
}

function bodyOf(ast: ASTNode): ASTNode[] {
  return ast.body as ASTNode[];
}

const plugin: SyntaxPlugin = {
  name: "test-syntax",
  statementStarts: ["signal"],
  parseStatement(context) {
    if (!context.check("Identifier", "signal")) return null;
    if (context.peek().type !== "Identifier") return null;
    const start = context.advance();
    const name = context.tokenString(context.expect("Identifier"), "signal name");
    context.expect("Punctuator", "=");
    const init = context.parseExpression();
    const call = context.withSpan({
      type: NodeType.CallExpression,
      callee: identifier("Signal"),
      args: [init],
    }, start);
    return context.withSpan({
      type: NodeType.ExpressionStatement,
      expression: {
        type: NodeType.AssignmentExpression,
        target: identifier(name),
        value: call,
      },
    }, start);
  },
  transform(program) {
    if (program.type !== NodeType.Program) return program;
    return {
      ...program,
      body: [
        {
          type: NodeType.ExpressionStatement,
          expression: {
            type: NodeType.AssignmentExpression,
            target: identifier("expanded"),
            value: literal(1),
          },
        },
        ...bodyOf(program),
      ],
    };
  },
};

describe("parser syntax extensions", () => {
  it("requires explicit opt-in for contextual syntax", () => {
    expect(() => parse("signal x = 1")).toThrow();
  });

  it("lets opted-in plugins parse contextual statements and lower to core AST", () => {
    const ast = parse("signal x = 1", { syntaxPlugins: [plugin] });
    const body = bodyOf(ast);
    expect(body).toHaveLength(2);
    expect(body[1]).toMatchObject({
      type: NodeType.ExpressionStatement,
      expression: {
        type: NodeType.AssignmentExpression,
        target: { type: NodeType.Identifier, name: "x" },
        value: {
          type: NodeType.CallExpression,
          callee: { type: NodeType.Identifier, name: "Signal" },
        },
      },
    });
  });

  it("runs plugin transforms after parsing", () => {
    const ast = parse("signal x = 1", { syntaxPlugins: [plugin] });
    expect(bodyOf(ast)[0]).toMatchObject({
      type: NodeType.ExpressionStatement,
      expression: {
        type: NodeType.AssignmentExpression,
        target: { type: NodeType.Identifier, name: "expanded" },
      },
    });
  });

  it("rejects duplicate plugin names", () => {
    expect(() => parse("1", { syntaxPlugins: [plugin, plugin] })).toThrow(/Duplicate syntax plugin/);
  });

  it("uses statement start keys to avoid unrelated parser calls", () => {
    let calls = 0;
    const coldPlugin: SyntaxPlugin = {
      name: "cold",
      statementStarts: ["cold"],
      parseStatement() {
        calls++;
        return null;
      },
    };

    parse("signal x = 1", { syntaxPlugins: [plugin, coldPlugin] });
    expect(calls).toBe(0);
  });

  it("lets plugins checkpoint and restore speculative parses", () => {
    const speculativePlugin: SyntaxPlugin = {
      name: "speculative",
      statementStarts: ["maybe"],
      parseStatement(context) {
        const checkpoint = context.checkpoint();
        context.advance();
        context.restore(checkpoint);
        return null;
      },
    };

    const ast = parse("maybe = 1", { syntaxPlugins: [speculativePlugin] });

    expect(bodyOf(ast)[0]).toMatchObject({
      type: NodeType.ExpressionStatement,
      expression: {
        type: NodeType.AssignmentExpression,
        target: { type: NodeType.Identifier, name: "maybe" },
      },
    });
  });

  it("rejects extension statements that do not advance the token stream", () => {
    const stuckPlugin: SyntaxPlugin = {
      name: "stuck",
      statementStarts: ["stuck"],
      parseStatement() {
        return {
          type: NodeType.ExpressionStatement,
          expression: identifier("stuck"),
        };
      },
    };

    expect(() => parse("stuck", { syntaxPlugins: [stuckPlugin] })).toThrow(/without consuming tokens/);
  });
});
