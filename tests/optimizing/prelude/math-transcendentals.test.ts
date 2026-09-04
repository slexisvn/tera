import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import {
  mathTranscendentalPrelude,
  rewriteMathTranscendentals,
} from "../../../src/optimizing/prelude/math-transcendentals.js";
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

describe("the prelude behind the Math functions the backends do not carry", () => {
  it("stays empty for a program that calls none of them", () => {
    expect(mathTranscendentalPrelude(roots("print(Math.sqrt(2.0))"))).toBe("");
  });

  it("carries only the function the program asked for", () => {
    const prelude = mathTranscendentalPrelude(roots("print(Math.exp(1.0))"));

    expect(prelude).toContain("fn _m_exp(x: float) -> float:");
    expect(prelude).not.toContain("fn _m_log(");
    expect(prelude).not.toContain("fn _m_sin(");
  });

  it("carries the helpers that function needs and no others", () => {
    const exponential = mathTranscendentalPrelude(roots("print(Math.exp(1.0))"));

    expect(exponential).toContain("fn _m_pow2(k: int) -> float:");
    expect(exponential).not.toContain("fn _m_exponent(");

    const logarithm = mathTranscendentalPrelude(roots("print(Math.log(1.0))"));

    expect(logarithm).toContain("fn _m_pow2(k: int) -> float:");
    expect(logarithm).toContain("fn _m_exponent(v: float) -> int:");
  });

  it("carries the argument reduction only the circular functions need", () => {
    const circular = mathTranscendentalPrelude(roots("print(Math.sin(1.0))"));

    expect(circular).toContain("fn _m_rem_pio2(x: float, y: float[]) -> int:");
    expect(circular).toContain("fn _m_kernel_rem_pio2(");
    expect(circular).toContain("fn _m_kernel_cos(x: float, y: float) -> float:");

    expect(mathTranscendentalPrelude(roots("print(Math.log(1.0))"))).not.toContain(
      "fn _m_rem_pio2(",
    );
  });

  it("declares every table inside the function that reads it", () => {
    const circular = mathTranscendentalPrelude(roots("print(Math.cos(1.0))"));

    for (const line of circular.split("\n")) {
      expect(line.startsWith("ipio2") || line.startsWith("pio2")).toBe(false);
    }
    expect(circular).toContain("  ipio2: int[] = [");
    expect(circular).toContain("  pio2: float[] = [");
  });

  it("carries each function once when a program calls one of them twice", () => {
    const prelude = mathTranscendentalPrelude(
      roots(src("print(Math.exp(1.0))", "print(Math.exp(2.0))")),
    );

    expect(prelude.split("fn _m_exp(").length - 1).toBe(1);
    expect(prelude.split("fn _m_pow2(").length - 1).toBe(1);
  });

  it("rewrites the call sites onto the prelude functions", () => {
    const parsed = roots(
      src("print(Math.exp(1.0))", "print(Math.log(2.0))", "print(Math.sin(3.0))"),
    );

    expect(rewriteMathTranscendentals(parsed)).toBe(3);

    const called = calleeNames(parsed[0]!);
    expect(called).toContain("_m_exp");
    expect(called).toContain("_m_log");
    expect(called).toContain("_m_sin");
  });

  it("leaves the Math functions the backends do carry alone", () => {
    const parsed = roots(src("print(Math.sqrt(2.0))", "print(Math.floor(1.5))"));

    expect(rewriteMathTranscendentals(parsed)).toBe(0);
    expect(mathTranscendentalPrelude(parsed)).toBe("");
  });

  it("leaves a member of the same name on something that is not Math alone", () => {
    const source = src(
      "class Curve:",
      "  public exp(x: float) -> float:",
      "    return x",
      "print(Curve().exp(1.0))",
    );

    expect(rewriteMathTranscendentals(roots(source))).toBe(0);
    expect(mathTranscendentalPrelude(roots(source))).toBe("");
  });

  it("leaves a call given the wrong number of arguments alone", () => {
    expect(rewriteMathTranscendentals(roots("print(Math.exp(1.0, 2.0))"))).toBe(0);
    expect(mathTranscendentalPrelude(roots("print(Math.exp())"))).toBe("");
  });

  it("answers what the interpreter answers for the one input fdlibm rounds differently", () => {
    expect(mathTranscendentalPrelude(roots("print(Math.exp(1.0))"))).toContain(
      `    return ${Math.E}`,
    );
  });
});
