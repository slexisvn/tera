import { describe, expect, it } from "vitest";
import { lowerToSemanticProgram } from "../../../src/frontend/checker/semantic-lowering.js";
import type { BlockNode, SemanticNode } from "../../../src/frontend/checker/semantic-ast.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

const blocks = (source: string): BlockNode[] =>
  lowerToSemanticProgram(source).body.filter(
    (node): node is BlockNode => node.kind === "Block",
  );

const only = (source: string): BlockNode => {
  const found = blocks(source);
  expect(found).toHaveLength(1);
  return found[0]!;
};

const casesOf = (block: BlockNode): BlockNode[] =>
  block.body.filter((node): node is BlockNode => node.kind === "Block");

const SWITCH = src(
  "switch v:",
  "  case 1:",
  '    print("one")',
  "  case 2:",
  '    print("two")',
  "  default:",
  '    print("other")',
);

describe("switch lowering", () => {
  it("lowers a switch to a single block", () => {
    expect(only(SWITCH).kind).toBe("Block");
  });

  it("marks the discriminant as a match subject rather than a condition", () => {
    expect(only(SWITCH).testRole).toBe("subject");
  });

  it("keeps the discriminant as the block test", () => {
    expect(only(SWITCH).test?.type).toBe("Identifier");
  });

  it("gives one nested block per case, default included", () => {
    expect(casesOf(only(SWITCH))).toHaveLength(3);
  });

  it("marks every case test as a label", () => {
    expect(casesOf(only(SWITCH)).map((entry) => entry.testRole)).toEqual([
      "label",
      "label",
      "label",
    ]);
  });

  it("hands every case the subject it is matched against", () => {
    const block = only(SWITCH);
    expect(casesOf(block).map((entry) => entry.subject)).toEqual([
      block.test,
      block.test,
      block.test,
    ]);
  });

  it("leaves the default case without a test", () => {
    expect(casesOf(only(SWITCH)).map((entry) => entry.test === undefined)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("carries the statements of each case into its block", () => {
    const bodies = casesOf(only(SWITCH)).map((entry) => entry.body.length);
    expect(bodies).toEqual([1, 1, 1]);
  });

  it("marks an if condition as a guard rather than a match label", () => {
    const [block] = blocks(src("if v:", '  print("yes")'));
    expect(block?.testRole).toBe("guard");
  });

  it("marks a while condition as a loop, which no guard narrowing follows", () => {
    const [block] = blocks(src("while v:", '  print("yes")'));
    expect(block?.testRole).toBe("loop");
  });

  it("hands an else branch the test it is the negation of", () => {
    const [, alternate] = blocks(
      src("if v:", '  print("yes")', "else:", '  print("no")'),
    );
    expect(alternate?.otherwise).toHaveLength(1);
    expect(alternate?.test).toBeUndefined();
  });

  it("hands each arm of an elif chain every test that failed before it", () => {
    const chain = blocks(
      src("if a:", "  print(1)", "else if b:", "  print(2)", "else:", "  print(3)"),
    );
    expect(chain.map((block) => (block.otherwise ?? []).length)).toEqual([0, 1, 2]);
  });

  it("lowers throw, break and continue to jumps a guard can exit through", () => {
    const body = lowerToSemanticProgram(
      src("while v:", '  throw "x"', "  break", "  continue"),
    ).body.filter((node): node is BlockNode => node.kind === "Block")[0]!.body;

    expect(body.map((node) => (node.kind === "Jump" ? node.via : node.kind))).toEqual([
      "throw",
      "break",
      "continue",
    ]);
  });

  it("keeps a nested switch inside its enclosing case", () => {
    const source = src(
      "switch a:",
      "  case 1:",
      "    switch b:",
      "      case 2:",
      '        print("inner")',
    );
    const outerCase = casesOf(only(source))[0]!;
    const inner = outerCase.body.filter(
      (node: SemanticNode): node is BlockNode => node.kind === "Block",
    );
    expect(inner.map((entry) => entry.testRole)).toEqual(["subject"]);
  });
});
