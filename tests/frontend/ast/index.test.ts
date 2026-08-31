import { describe, expect, it } from "vitest";
import {
  ArrowFunctionExpression,
  ClassDeclaration,
  Identifier,
  adoptContextualSignature,
  astChildren,
  declaredParamInfo,
  functionParameters,
  isRestParameter,
  parameterName,
  type ASTNode,
  type FunctionParamInfo,
  type ParamNode,
} from "../../../src/frontend/ast/index.js";

const body = () => Identifier("n");

function arrow(params: ParamNode[], info?: FunctionParamInfo[], returns?: string): ASTNode {
  const node = ArrowFunctionExpression(params, body(), true);
  if (info !== undefined) node._paramInfo = info;
  if (returns !== undefined) node._returnType = returns;
  return node;
}

const typesOf = (node: ASTNode) => (declaredParamInfo(node) ?? []).map((entry) => entry.type);

describe("parameterName", () => {
  it("reads a bare identifier parameter", () => {
    expect(parameterName("n")).toBe("n");
  });

  it("reads a named parameter record", () => {
    expect(parameterName({ name: "n", rest: true })).toBe("n");
  });

  it("has no name for a destructuring pattern", () => {
    expect(parameterName({ pattern: "a" })).toBeNull();
  });
});

describe("isRestParameter", () => {
  it("recognises a gathering parameter", () => {
    expect(isRestParameter({ name: "rest", rest: true })).toBe(true);
  });

  it("treats a plain identifier as positional", () => {
    expect(isRestParameter("n")).toBe(false);
  });
});

describe("functionParameters", () => {
  it("returns the declared parameters", () => {
    expect(functionParameters(arrow(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("returns nothing when a node has no parameter list", () => {
    expect(functionParameters(Identifier("n"))).toEqual([]);
  });
});

describe("adoptContextualSignature", () => {
  it("gives an unannotated parameter the contextual type", () => {
    const node = arrow(["n"]);
    adoptContextualSignature(node, ["int"], null);
    expect(typesOf(node)).toEqual(["int"]);
  });

  it("names the parameter it typed", () => {
    const node = arrow(["n"]);
    adoptContextualSignature(node, ["int"], null);
    expect(declaredParamInfo(node)?.map((entry) => entry.name)).toEqual(["n"]);
  });

  it("keeps an annotation the source already spells out", () => {
    const node = arrow(["n"], [{ name: "n", type: "float" }]);
    adoptContextualSignature(node, ["int"], null);
    expect(typesOf(node)).toEqual(["float"]);
  });

  it("fills only the parameters the source left open", () => {
    const node = arrow(["a", "b"], [
      { name: "a", type: "any" },
      { name: "b", type: "string" },
    ]);
    adoptContextualSignature(node, ["int", "int"], null);
    expect(typesOf(node)).toEqual(["int", "string"]);
  });

  it("matches contextual types to parameters by position", () => {
    const node = arrow(["a", "b"]);
    adoptContextualSignature(node, ["int", "string"], null);
    expect(typesOf(node)).toEqual(["int", "string"]);
  });

  it("leaves a parameter untyped when the context says nothing about it", () => {
    const node = arrow(["a", "b"]);
    adoptContextualSignature(node, ["int"], null);
    expect(typesOf(node)).toEqual(["int", undefined]);
  });

  it("writes nothing when every contextual type is uninformative", () => {
    const node = arrow(["n"]);
    adoptContextualSignature(node, ["any"], null);
    expect(declaredParamInfo(node)).toBeNull();
  });

  it("skips a contextual type that names no runtime shape", () => {
    const node = arrow(["n"]);
    adoptContextualSignature(node, ["unknown"], null);
    expect(declaredParamInfo(node)).toBeNull();
  });

  it("does not type a gathering parameter from a positional slot", () => {
    const node = arrow([{ name: "rest", rest: true }], [
      { name: "rest", type: "any", rest: true },
    ]);
    adoptContextualSignature(node, ["int"], null);
    expect(typesOf(node)).toEqual(["any"]);
  });

  it("counts positions past a gathering parameter without consuming one", () => {
    const node = arrow(["a", { name: "rest", rest: true }]);
    adoptContextualSignature(node, ["int"], null);
    expect(typesOf(node)).toEqual(["int", undefined]);
  });

  it("adopts a contextual return type", () => {
    const node = arrow(["n"]);
    adoptContextualSignature(node, [], "int");
    expect(node._returnType).toBe("int");
  });

  it("keeps a return type the source already spells out", () => {
    const node = arrow(["n"], undefined, "float");
    adoptContextualSignature(node, [], "int");
    expect(node._returnType).toBe("float");
  });

  it("leaves the return type open when the context is uninformative", () => {
    const node = arrow(["n"]);
    adoptContextualSignature(node, [], "void");
    expect(node._returnType).toBeUndefined();
  });

  it("ignores parameters it cannot name", () => {
    const node = arrow([{ pattern: "a" }]);
    adoptContextualSignature(node, ["int"], null);
    expect(declaredParamInfo(node)).toBeNull();
  });
});

describe("astChildren", () => {
  it("reads a node held directly on a property", () => {
    const held = Identifier("n");

    expect(astChildren({ type: "Holder", held } as unknown as ASTNode)).toEqual([held]);
  });

  it("reads every node held in an array property", () => {
    const first = Identifier("a");
    const second = Identifier("b");

    expect(astChildren({ type: "Holder", held: [first, second] } as unknown as ASTNode)).toEqual([
      first,
      second,
    ]);
  });

  it("reads a node a class member holds inside a plain object", () => {
    const method = arrow([]);
    const node = ClassDeclaration("C", null, null, [{ name: "run", kind: "method", func: method }]);

    expect(astChildren(node)).toContain(method);
  });

  it("reads a body a class member holds inside a plain object", () => {
    const statement = Identifier("n");
    const node = ClassDeclaration("C", null, null, [
      { name: "run", kind: "method", body: [statement] },
    ]);

    expect(astChildren(node)).toContain(statement);
  });

  it("holds nothing for a property that carries no node", () => {
    const node = { type: "Holder", name: "n", count: 2, missing: null };

    expect(astChildren(node as unknown as ASTNode)).toEqual([]);
  });
});
