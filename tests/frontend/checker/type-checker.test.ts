import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { checkProgram } from "../../../src/frontend/checker/index.js";
import { astToSemanticProgram } from "../../../src/frontend/checker/semantic-lowering.js";
import {
  NodeType,
  astChildren,
  declaredParamInfo,
  type ASTNode,
} from "../../../src/frontend/ast/index.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

interface RecordedSignature {
  readonly params: ReadonlyArray<string | undefined>;
  readonly returns: string | undefined;
}

function checked(source: string): { ast: ASTNode; messages: string[] } {
  const ast = parse(source, {});
  const { diagnostics } = checkProgram(astToSemanticProgram(ast), { mode: "strict" });
  return { ast, messages: diagnostics.map((entry) => entry.message) };
}

const diagnose = (source: string): string[] => checked(source).messages;

function functionLiterals(node: ASTNode, found: ASTNode[] = []): ASTNode[] {
  if (node.type === NodeType.ArrowFunctionExpression) found.push(node);
  for (const child of astChildren(node)) functionLiterals(child, found);
  return found;
}

function signatures(source: string): RecordedSignature[] {
  const { ast } = checked(source);
  return functionLiterals(ast).map((node) => ({
    params: (declaredParamInfo(node) ?? []).map((entry) => entry.type),
    returns: typeof node._returnType === "string" ? node._returnType : undefined,
  }));
}

describe("contextual lambda signatures", () => {
  it("types a lambda parameter from the declared variable type", () => {
    expect(signatures(src("inc: (int) -> int = n => n + 1", "print(inc(4))"))).toEqual([
      { params: ["int"], returns: "int" },
    ]);
  });

  it("types a lambda parameter from the parameter it is passed to", () => {
    const source = src(
      "fn apply(f: (int) -> int, x: int) -> int:",
      "  return f(x)",
      "print(apply(n => n + 1, 4))",
    );
    expect(signatures(source)).toEqual([{ params: ["int"], returns: "int" }]);
  });

  it("types a returned lambda from the declared return type", () => {
    const source = src(
      "fn make(base: int) -> (int) -> int:",
      "  return n => n + base",
      "print(make(3)(4))",
    );
    expect(signatures(source)).toEqual([{ params: ["int"], returns: "int" }]);
  });

  it("accepts a returned lambda that matches the declared return type", () => {
    const source = src("fn make(base: int) -> (int) -> int:", "  return n => n + base");
    expect(diagnose(source)).toEqual([]);
  });

  it("reports a returned lambda whose result does not match", () => {
    const source = src("fn make() -> (int) -> int:", '  return n => "text"');
    expect(diagnose(source)).toEqual([
      "Type 'string' is not assignable to return type 'int'",
    ]);
  });

  it("keeps the annotation the lambda spells out itself", () => {
    const source = src("inc: (float) -> float = (n: int) => n + 1.0", "print(inc(4.0))");
    expect(signatures(source)[0]?.params).toEqual(["int"]);
  });

  it("types nested lambdas through a curried return type", () => {
    const source = src(
      "fn add(a: int) -> (int) -> (int) -> int:",
      "  return b => c => a + b + c",
    );
    expect(signatures(source)).toEqual([
      { params: ["int"], returns: "(int) -> int" },
      { params: ["int"], returns: "int" },
    ]);
  });

  it("accepts a curried lambda that matches the declared return type", () => {
    const source = src(
      "fn outer(a: int) -> (int) -> (int) -> int:",
      "  return b => c => a + b + c",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("accepts a curried lambda that spells its own parameter types out", () => {
    const source = src(
      "fn outer(a: int) -> (int) -> (int) -> int:",
      "  return (b: int) => (c: int) => a + b + c",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("types a lambda inside an array literal from the declared element type", () => {
    expect(diagnose(src("fs: ((int) -> int)[] = [n => n + 1]"))).toEqual([]);
    expect(signatures(src("fs: ((int) -> int)[] = [n => n + 1]"))).toEqual([
      { params: ["int"], returns: "int" },
    ]);
  });

  it("points at the lambda in an array literal whose result does not match", () => {
    expect(diagnose(src('fs: ((int) -> int)[] = [n => "text"]'))).toEqual([
      "Type 'string' is not assignable to return type 'int'",
    ]);
  });

  it("lets a lambda with a declared function type call itself", () => {
    expect(diagnose(src("fact: (int) -> int = n => n < 2 ? 1 : n * fact(n - 1)"))).toEqual([]);
  });

  it("still reports a name a declaration without a function type cannot see yet", () => {
    expect(diagnose(src("n: int = n + 1"))).toEqual(["undefined name 'n'"]);
  });

  it("records nothing when the lambda has no contextual type", () => {
    expect(signatures(src("inc = n => n + 1", "print(inc(4))"))).toEqual([
      { params: [], returns: undefined },
    ]);
  });

  it("leaves the return type open when the context returns nothing useful", () => {
    const source = src("fn run(f: (int) -> void, x: int) -> void:", "  f(x)", "run(n => print(n), 1)");
    expect(signatures(source)[0]?.returns).toBeUndefined();
  });

  it("types the parameter even when the body is a block", () => {
    const source = src(
      "fn apply(f: (int) -> int, x: int) -> int:",
      "  return f(x)",
      "print(apply(n => n * 2, 4))",
    );
    expect(signatures(source)[0]?.params).toEqual(["int"]);
  });
});

describe("switch subjects and case labels", () => {
  const switchOn = (declared: string, label: string, value: string) =>
    src(
      `fn name(v: ${declared}) -> string:`,
      "  switch v:",
      `    case ${label}:`,
      '      return "hit"',
      "    default:",
      '      return "miss"',
      `print(name(${value}))`,
    );

  it("accepts an int subject", () => {
    expect(diagnose(switchOn("int", "1", "1"))).toEqual([]);
  });

  it("accepts a string subject", () => {
    expect(diagnose(switchOn("string", '"a"', '"a"'))).toEqual([]);
  });

  it("accepts a float subject", () => {
    expect(diagnose(switchOn("float", "1.5", "1.5"))).toEqual([]);
  });

  it("accepts a bool subject", () => {
    expect(diagnose(switchOn("bool", "true", "true"))).toEqual([]);
  });

  it("reports a case label that can never equal the subject", () => {
    expect(diagnose(switchOn("int", '"a"', "1"))).toEqual([
      "Type 'string' is not comparable to switch subject type 'int'",
    ]);
  });

  it("says nothing about a subject whose type is unknown", () => {
    const source = src(
      "fn name(v) -> string:",
      "  switch v:",
      "    case 1:",
      '      return "hit"',
      "  return \"miss\"",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("still checks the statements inside a case", () => {
    const source = src(
      "fn name(v: int) -> string:",
      "  switch v:",
      "    case 1:",
      "      n: int = \"text\"",
      "      return \"hit\"",
      "  return \"miss\"",
    );
    expect(diagnose(source)).toEqual(["Type 'string' is not assignable to 'int'"]);
  });

  it("still checks the subject expression itself", () => {
    const source = src(
      "fn name(v: int) -> string:",
      "  switch missing:",
      "    case 1:",
      '      return "hit"',
      "  return \"miss\"",
    );
    expect(diagnose(source)).toEqual(["undefined name 'missing'"]);
  });

  it("keeps requiring a bool for an if condition", () => {
    const source = src("fn f(v: int) -> int:", "  if v:", "    return 1", "  return 0");
    expect(diagnose(source)).toEqual([
      "Type 'int' is not assignable to condition type 'bool'",
    ]);
  });

  it("keeps requiring a bool for a while condition", () => {
    const source = src("fn f(v: int) -> int:", "  while v:", "    return 1", "  return 0");
    expect(diagnose(source)).toEqual([
      "Type 'int' is not assignable to condition type 'bool'",
    ]);
  });
});

describe("collection iteration", () => {
  it("accepts iterating a set directly", () => {
    expect(diagnose(src("s = Set()", "s.add(1)", "for v of s:", "  print(v)"))).toEqual([]);
  });

  it("accepts iterating a map directly", () => {
    expect(diagnose(src("m = Map()", 'm.set("a", 1)', "for e of m:", "  print(e)"))).toEqual([]);
  });

  it("still rejects iterating something that is not a sequence", () => {
    expect(diagnose(src("n: int = 1", "for v of n:", "  print(v)"))).toEqual([
      "Type 'int' is not iterable",
    ]);
  });
});

describe("spread arguments", () => {
  it("lets a spread stand in for the parameters it fills", () => {
    const source = src(
      "fn add(a: int, b: int) -> int:",
      "  return a + b",
      "xs: int[] = [1, 2]",
      "print(add(...xs))",
    );
    expect(diagnose(source)).toEqual([]);
  });

  it("reports a spread whose elements do not fit the parameters", () => {
    const source = src(
      "fn add(a: int, b: int) -> int:",
      "  return a + b",
      'xs: string[] = ["a"]',
      "print(add(...xs))",
    );
    expect(diagnose(source)).toEqual([
      "Type 'string' is not assignable to parameter 'a: int'",
      "Type 'string' is not assignable to parameter 'b: int'",
    ]);
  });

  it("still reports spreading something that is not iterable", () => {
    const source = src(
      "fn add(a: int, b: int) -> int:",
      "  return a + b",
      "n: int = 1",
      "print(add(...n))",
    );
    expect(diagnose(source)).toEqual(["Type 'int' is not iterable"]);
  });

  it("gathers a spread into a rest parameter", () => {
    const source = src(
      "fn total(...ns: int) -> int:",
      "  return 0",
      "xs: int[] = [1, 2]",
      "print(total(...xs))",
    );
    expect(diagnose(source)).toEqual([]);
  });
});
