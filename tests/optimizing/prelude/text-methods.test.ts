import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import {
  rewriteTextMethods,
  textMethodNamed,
  textMethodPrelude,
} from "../../../src/optimizing/prelude/text-methods.js";
import { STRING_TO_END } from "../../../src/optimizing/metadata/builtin-methods.js";
import {
  astChildren,
  CallExpression,
  Literal,
  MemberExpression,
  NodeType,
  type ASTNode,
} from "../../../src/frontend/ast/index.js";

const src = (...lines: string[]) => lines.join("\n");

const roots = (source: string): readonly ASTNode[] => [parse(`${source}\n`)];

const SUBSTRING = "substring";
const LAST_INDEX_OF = "last_index_of";
const COMPUTED = true;
const NAMED = false;

const preludeFn = (member: string): string => textMethodNamed(member)!.source[0]!;

const calling = (member: string, computed: boolean): readonly ASTNode[] => [
  CallExpression(MemberExpression(Literal("abc"), member, computed), [Literal(1)]),
];

function callsTo(node: ASTNode, name: string, found: ASTNode[] = []): ASTNode[] {
  if (node === null || node === undefined) return found;
  if (node.type === NodeType.CallExpression) {
    const callee = node.callee as ASTNode;
    if (callee.type === NodeType.Identifier && String(callee.name) === name) found.push(node);
  }
  for (const child of astChildren(node)) callsTo(child, name, found);
  return found;
}

function argumentsHandedTo(parsed: readonly ASTNode[], member: string): unknown[] {
  const calls = callsTo(parsed[0]!, textMethodNamed(member)!.fn);
  expect(calls).toHaveLength(1);
  return (calls[0]!.args as ASTNode[]).map((argument) => argument.value);
}

describe("the prelude behind the text methods the backends do not carry", () => {
  it("stays empty for a program that calls neither", () => {
    expect(textMethodPrelude(roots('print("abc".slice(1))'))).toBe("");
  });

  it("carries the function for the member the program calls", () => {
    const prelude = textMethodPrelude(roots('print("abc".substring(1))'));

    expect(prelude).toContain(preludeFn(SUBSTRING));
  });

  it("leaves the call sites of a member an array also carries to the receiver's type", () => {
    const source = src("xs: int[] = [1, 2, 1]", "print(xs.last_index_of(1))");

    expect(textMethodPrelude(roots(source))).toContain(preludeFn(LAST_INDEX_OF));
    expect(rewriteTextMethods(roots(source))).toBe(0);
  });

  it("still rewrites the call sites of a member only text carries", () => {
    const source = src('xs: int[] = [1]', "print(xs.last_index_of(1))", 'print("ab".substring(1))');

    expect(rewriteTextMethods(roots(source))).toBe(1);
  });

  it("still carries a shared member's function where a class declares that same member", () => {
    const shared = src(
      "class Line:",
      "  public last_index_of(a: string) -> int:",
      "    return 0",
      'print(Line().last_index_of("a"))',
    );

    expect(textMethodPrelude(roots(shared))).toContain(preludeFn(LAST_INDEX_OF));
  });

  it("stands aside for a class that declares the same member itself", () => {
    const source = src(
      "class Line:",
      "  public substring(a: int) -> string:",
      '    return "x"',
      "print(Line().substring(1))",
    );

    expect(textMethodPrelude(roots(source))).toBe("");
    expect(rewriteTextMethods(roots(source))).toBe(0);
  });

  it("rewrites the call into the prelude function with the receiver first", () => {
    const parsed = roots('print("abcdef".substring(1, 4))');

    expect(rewriteTextMethods(parsed)).toBe(1);

    expect(argumentsHandedTo(parsed, SUBSTRING)).toEqual(["abcdef", 1, 4]);
  });

  it("fills the end a one-argument substring left out", () => {
    const parsed = roots('print("abcdef".substring(2))');
    rewriteTextMethods(parsed);

    expect(argumentsHandedTo(parsed, SUBSTRING)).toEqual(["abcdef", 2, STRING_TO_END]);
  });

  it("leaves a substring given more arguments than the method takes alone", () => {
    expect(rewriteTextMethods(roots('print("abc".substring(1, 2, 3))'))).toBe(0);
  });

  it("leaves a call that reaches the member through a computed name alone", () => {
    expect(rewriteTextMethods(calling(SUBSTRING, COMPUTED))).toBe(0);
  });

  it("rewrites that same call once the member is named outright", () => {
    expect(rewriteTextMethods(calling(SUBSTRING, NAMED))).toBe(1);
  });
});
