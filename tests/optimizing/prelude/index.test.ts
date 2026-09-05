import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import {
  adoptSourcePreludes,
  LOWERED_PRELUDE_FUNCTIONS,
  sourcePreludes,
} from "../../../src/optimizing/prelude/index.js";
import { FLOAT_MOD_FN } from "../../../src/optimizing/prelude/float-mod.js";
import { astChildren, NodeType, type ASTNode } from "../../../src/frontend/ast/index.js";

const src = (...lines: string[]) => lines.join("\n");

const roots = (source: string): readonly ASTNode[] => [parse(`${source}\n`)];

function calleeNames(node: ASTNode, found: string[] = []): string[] {
  if (node === null || node === undefined) return found;
  if (node.type === NodeType.CallExpression) {
    const callee = node.callee as ASTNode;
    if (callee.type === NodeType.Identifier) found.push(String(callee.name));
  }
  for (const child of astChildren(node)) calleeNames(child, found);
  return found;
}

describe("the preludes a program's own source pulls in", () => {
  it("carries nothing for a program that asks for none of them", () => {
    expect(sourcePreludes(roots("print(1 + 2)"))).toBe("");
  });

  it("carries every helper a program that asks for several of them needs", () => {
    const prelude = sourcePreludes(roots(src("print(Math.exp(1.0))", "print(7.5 % 2.5)")));

    expect(prelude).toContain(`fn ${FLOAT_MOD_FN}(`);
    expect(prelude).toContain("fn _m_exp(");
  });

  it("answers a prelude the parser can read back", () => {
    const prelude = sourcePreludes(roots(src("print(Math.log(1.0))", "print(7.5 % 2.5)")));

    expect(() => parse(prelude)).not.toThrow();
  });
});

describe("adopting the calls a prelude answers for", () => {
  it("points a call at the helper the prelude carries", () => {
    const program = roots("print(Math.exp(1.0))");
    adoptSourcePreludes(program);

    expect(calleeNames(program[0]!)).toContain("_m_exp");
  });

  it("leaves a program alone when only a lowering adopts its prelude", () => {
    const program = roots("print(7.5 % 2.5)");
    const before = JSON.stringify(program[0]);
    adoptSourcePreludes(program);

    expect(JSON.stringify(program[0])).toBe(before);
  });
});

describe("the prelude helpers only a lowering ever calls", () => {
  it("names the remainder helper, which no source call reaches", () => {
    expect([...LOWERED_PRELUDE_FUNCTIONS]).toContain(FLOAT_MOD_FN);
  });

  it("leaves out a helper a source rewrite already points calls at", () => {
    expect([...LOWERED_PRELUDE_FUNCTIONS]).not.toContain("_m_exp");
  });
});
