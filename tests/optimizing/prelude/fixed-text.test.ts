import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { NodeType, type ASTNode } from "../../../src/frontend/ast/index.js";
import {
  fixedTextPrelude,
  rewriteFixedTexts,
  FIXED_DIGITS_CLASS,
  FIXED_FORMAT_METHOD,
  FIXED_TEXT_FUNCTION,
  FIXED_TEXT_MEMBER,
} from "../../../src/optimizing/prelude/fixed-text.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

const preludeFor = (source: string) => fixedTextPrelude([parse(source)]);

function rewritten(source: string): ASTNode {
  const program = parse(source);
  rewriteFixedTexts([program]);
  return program;
}

function callsIn(node: ASTNode, found: ASTNode[] = []): ASTNode[] {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if ((node as ASTNode).type === NodeType.CallExpression) found.push(node);
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(value)) for (const child of value) callsIn(child as ASTNode, found);
    else if (value !== null && typeof value === "object") callsIn(value as ASTNode, found);
  }
  return found;
}

const formats = (call: ASTNode) => (call.callee as ASTNode).name === FIXED_TEXT_FUNCTION;

describe("fixedTextPrelude", () => {
  it("declares nothing for a program that never formats a number", () => {
    expect(preludeFor(src("print(1.5)"))).toBe("");
  });

  it("declares the formatter for a program that asks for fixed digits", () => {
    const prelude = preludeFor(src("print((1.5).to_fixed(2))"));

    expect(prelude).toContain(`  public ${FIXED_FORMAT_METHOD}(value: float, digits: int) -> string:`);
    expect(prelude).toContain(`fn ${FIXED_TEXT_FUNCTION}(value: float, digits: int) -> string:`);
  });

  it("finds the call however deeply the program nests it", () => {
    expect(
      preludeFor(
        src(
          "fn label(values: float[]) -> string:",
          "  out: string = \"\"",
          "  for value of values:",
          "    if value > 0.0:",
          "      out = value.to_fixed(3)",
          "  return out",
        ),
      ),
    ).not.toBe("");
  });

  it("stands aside for a class that declares the member itself", () => {
    expect(
      preludeFor(
        src(
          "class Money:",
          "  public constructor(cents: int):",
          "    this.cents = cents",
          `  public ${FIXED_TEXT_MEMBER}(digits: int) -> string:`,
          "    return digits.to_string()",
          "print(Money(5).to_fixed(2))",
        ),
      ),
    ).toBe("");
  });

  it("declares the formatter once for several roots that call it", () => {
    const prelude = fixedTextPrelude([
      parse(src("print((1.5).to_fixed(1))")),
      parse(src("print((2.5).to_fixed(2))")),
    ]);
    const declarations = prelude
      .split("\n")
      .filter((line) => line.startsWith(`class ${FIXED_DIGITS_CLASS}:`));

    expect(declarations.length).toBe(1);
  });

  it("parses back into classes the compiler can see", () => {
    const program = parse(preludeFor(src("print((1.5).to_fixed(2))")));
    const declared = (program.body as ASTNode[])
      .filter((node) => node.type === NodeType.ClassDeclaration)
      .map((node) => node.name);

    expect(declared).toContain(FIXED_DIGITS_CLASS);
  });
});

describe("rewriteFixedTexts", () => {
  it("turns the member call into a call on the formatter", () => {
    const program = rewritten(src("print((1.5).to_fixed(2))"));
    const call = callsIn(program).find(formats);

    expect(call).toBeDefined();
    expect((call!.args as ASTNode[]).length).toBe(2);
  });

  it("keeps the receiver as the value being formatted", () => {
    const program = rewritten(src("amount: float = 2.5", "print(amount.to_fixed(2))"));
    const call = callsIn(program).find(formats)!;
    const [value, digits] = call.args as ASTNode[];

    expect(value!.name).toBe("amount");
    expect(digits!.value).toBe(2);
  });

  it("asks for no digits when the call names none", () => {
    const program = rewritten(src("print((2.5).to_fixed())"));
    const call = callsIn(program).find(formats)!;

    expect((call.args as ASTNode[]).length).toBe(2);
    expect((call.args as ASTNode[])[1]!.value).toBe(0);
  });

  it("reports how many calls it adopted", () => {
    const program = parse(src("print((1.5).to_fixed(1))", "print((2.5).to_fixed(2))"));

    expect(rewriteFixedTexts([program])).toBe(2);
  });

  it("leaves a class that declares the member alone", () => {
    const source = src(
      "class Money:",
      "  public constructor(cents: int):",
      "    this.cents = cents",
      `  public ${FIXED_TEXT_MEMBER}(digits: int) -> string:`,
      "    return digits.to_string()",
      "print(Money(5).to_fixed(2))",
    );
    const program = parse(source);

    expect(rewriteFixedTexts([program])).toBe(0);
  });

  it("leaves a computed member alone", () => {
    const program = parse(src("names = { to_fixed: 1 }", 'print(names["to_fixed"])'));

    expect(rewriteFixedTexts([program])).toBe(0);
  });
});
