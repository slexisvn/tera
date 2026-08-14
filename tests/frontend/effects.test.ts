import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser/language.js";
import { analyzeEffects } from "../../src/frontend/effects/index.js";
import { NodeType, type ASTNode } from "../../src/frontend/ast/index.js";

type CallNode = ASTNode & { callee: ASTNode; implicitAwait?: boolean };
type FunctionNode = ASTNode & { name?: string | null; async?: boolean };

function walk(node: ASTNode, visit: (node: ASTNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object" && "type" in item) walk(item as ASTNode, visit);
    } else if (value && typeof value === "object" && "type" in value) {
      walk(value as ASTNode, visit);
    }
  }
}

function analyze(source: string) {
  const program = analyzeEffects(parse(source));
  const calls: CallNode[] = [];
  const functions = new Map<string, FunctionNode>();
  walk(program, (node) => {
    if (node.type === NodeType.CallExpression) calls.push(node as CallNode);
    if (node.type === NodeType.FunctionDeclaration) {
      const fn = node as FunctionNode;
      if (fn.name) functions.set(String(fn.name), fn);
    }
  });
  return {
    isAsync: (name: string) => functions.get(name)?.async === true,
    awaitsCallTo: (callee: string) =>
      calls.some(
        (call) =>
          call.callee.type === NodeType.Identifier &&
          String((call.callee as { name: unknown }).name) === callee &&
          call.implicitAwait === true,
      ),
    callTo: (callee: string) =>
      calls.find(
        (call) => call.callee.type === NodeType.Identifier && String((call.callee as { name: unknown }).name) === callee,
      ),
  };
}

const load = ["fn load():", "  return DataFrame(a=[1]).collect()", ""].join("\n");

describe("effect analysis", () => {
  describe("first-order propagation", () => {
    it("marks a function that awaits a domain method as async", () => {
      expect(analyze(load).isAsync("load")).toBe(true);
    });

    it("propagates async to a direct caller and awaits the call", () => {
      const result = analyze(`${load}fn rows():\n  return load()\n`);
      expect(result.isAsync("rows")).toBe(true);
      expect(result.awaitsCallTo("load")).toBe(true);
    });

    it("leaves a purely synchronous function alone", () => {
      const result = analyze("fn add(a, b):\n  return a + b\nfn use():\n  return add(1, 2)\n");
      expect(result.isAsync("add")).toBe(false);
      expect(result.isAsync("use")).toBe(false);
      expect(result.awaitsCallTo("add")).toBe(false);
    });
  });

  describe("0-CFA callee resolution", () => {
    it("resolves a callee bound to a parameter and awaits it", () => {
      const result = analyze(`${load}fn apply(f):\n  return f()\napply(load)\n`);
      expect(result.awaitsCallTo("f")).toBe(true);
      expect(result.isAsync("apply")).toBe(true);
    });

    it("keeps a parameter call synchronous when only sync functions flow in", () => {
      const source = [
        "fn addOne(x):",
        "  return x + 1",
        "fn apply(f, v):",
        "  return f(v)",
        "apply(addOne, 1)",
      ].join("\n");
      const result = analyze(source);
      expect(result.awaitsCallTo("f")).toBe(false);
      expect(result.isAsync("apply")).toBe(false);
    });

    it("resolves a callee bound to a variable", () => {
      const result = analyze(`${load}g = load\ng()\n`);
      expect(result.awaitsCallTo("g")).toBe(true);
    });

    it("threads a callee through two levels of parameter passing", () => {
      const source = [
        load,
        "fn apply(f):",
        "  return f()",
        "fn outer(g):",
        "  return apply(g)",
        "outer(load)",
      ].join("\n");
      const result = analyze(source);
      expect(result.awaitsCallTo("f")).toBe(true);
      expect(result.isAsync("apply")).toBe(true);
      expect(result.isAsync("outer")).toBe(true);
    });

    it("merges every function that flows into one parameter", () => {
      const source = [
        load,
        "fn pure():",
        "  return 1",
        "fn apply(f):",
        "  return f()",
        "apply(pure)",
        "apply(load)",
      ].join("\n");
      const result = analyze(source);
      expect(result.awaitsCallTo("f")).toBe(true);
      expect(result.isAsync("apply")).toBe(true);
    });

    it("stays synchronous when only sync functions are merged", () => {
      const source = [
        "fn one():",
        "  return 1",
        "fn two():",
        "  return 2",
        "fn apply(f):",
        "  return f()",
        "apply(one)",
        "apply(two)",
      ].join("\n");
      expect(analyze(source).awaitsCallTo("f")).toBe(false);
    });
  });

  describe("over-approximation", () => {
    it("awaits a call through a binding it cannot resolve", () => {
      const result = analyze(`${load}fns = [load]\npicked = fns[0]\npicked()\n`);
      expect(result.awaitsCallTo("picked")).toBe(true);
    });

    it("awaits a parameter call when nothing ever flows in", () => {
      const result = analyze("fn apply(f):\n  return f()\n");
      expect(result.awaitsCallTo("f")).toBe(true);
      expect(result.isAsync("apply")).toBe(true);
    });

    it("does not treat an unknown global as an unresolved closure", () => {
      const result = analyze("fn use():\n  return print(1)\n");
      expect(result.awaitsCallTo("print")).toBe(false);
      expect(result.isAsync("use")).toBe(false);
    });
  });

  describe("recursion", () => {
    it("reaches a fixpoint on a self-recursive sync function", () => {
      const result = analyze("fn countdown(n):\n  if n > 0:\n    return countdown(n - 1)\n  return 0\n");
      expect(result.isAsync("countdown")).toBe(false);
    });

    it("propagates async through mutual recursion", () => {
      const source = [
        load,
        "fn ping(n):",
        "  return pong(n)",
        "fn pong(n):",
        "  return load()",
        "ping(1)",
      ].join("\n");
      const result = analyze(source);
      expect(result.isAsync("pong")).toBe(true);
      expect(result.isAsync("ping")).toBe(true);
    });
  });
});
