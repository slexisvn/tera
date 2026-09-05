import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { FLOAT_MOD_FN, floatModPrelude } from "../../../src/optimizing/prelude/float-mod.js";
import type { ASTNode } from "../../../src/frontend/ast/index.js";

const src = (...lines: string[]) => lines.join("\n");

const roots = (source: string): readonly ASTNode[] => [parse(`${source}\n`)];

const preludeFor = (source: string) => floatModPrelude(roots(source));

describe("the prelude behind a remainder the backends cannot take", () => {
  it("stays empty for a program that takes no remainder", () => {
    expect(preludeFor("print(7.5 / 2.5)")).toBe("");
  });

  it("carries the helper for a program that spells a remainder", () => {
    expect(preludeFor("print(7.5 % 2.5)")).toContain(`fn ${FLOAT_MOD_FN}(`);
  });

  it("carries the helper for a remainder written as an assignment", () => {
    expect(preludeFor(src("x = 7.5", "x %= 2.5", "print(x)"))).toContain(`fn ${FLOAT_MOD_FN}(`);
  });

  it("carries the helper once however many remainders a program takes", () => {
    const prelude = preludeFor(src("print(7.5 % 2.5)", "print(9.5 % 4.0)"));

    expect(prelude.split(`fn ${FLOAT_MOD_FN}(`)).toHaveLength(2);
  });

  it("does not mistake a division or a multiplication for a remainder", () => {
    expect(preludeFor(src("print(7.5 / 2.5)", "print(7.5 * 2.5)", "print(7.5 - 2.5)"))).toBe("");
  });

  it("answers a helper the parser can read back", () => {
    expect(() => parse(preludeFor("print(7.5 % 2.5)"))).not.toThrow();
  });

  it("declares the helper over two floats answering a float", () => {
    expect(preludeFor("print(7.5 % 2.5)")).toContain(
      `fn ${FLOAT_MOD_FN}(left: float, right: float) -> float:`,
    );
  });
});
